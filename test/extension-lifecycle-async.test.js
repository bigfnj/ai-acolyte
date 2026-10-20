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
// and the standing decision in this suite (test/extension-activation.test.js:505#sharing)
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

  // The same wedge, settled as a FAILURE: a scan that someone else is waiting on and
  // that then throws. Reached by the Review tests below.
  fail(message) {
    this.emit('message', { ok: false, error: { message } });
    this.emit('exit', 0);
  }

  terminate() { this.terminated = true; return Promise.resolve(0); }
}

// A worker that answers at once with a failure, the shape the runner turns into a
// rejected scan (autoLearnWorkerRunner.js, the `!message?.ok` leg). `failWorkers: N`
// makes the first N Auto Learn workers this; the rest are FakeWorkers.
class FailingWorker extends EventEmitter {
  constructor() {
    super();
    setImmediate(() => {
      this.emit('message', { ok: false, error: { message: 'history unreadable' } });
      this.emit('exit', 0);
    });
  }

  terminate() { return Promise.resolve(0); }
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

// The same 200, but it keeps what the download registered on it. Two things need
// that and neither is reachable through the inert version above: firing the
// RESPONSE stream's 'error' — one of the four independent channels that reach
// `fail` — and getting hold of the write stream, which is the only way to drive
// a transfer to 'finish' and reach the rename. `bytes` is counted, never
// allocated: the extension only reads `chunk.length`, so a 6MB chunk costs
// nothing and still clears the 5MB "this is not an HTML error page" floor.
function liveBodyResponse() {
  const handlers = {};
  const res = {
    statusCode: 200,
    headers: { 'content-length': String(32 * 1024 * 1024) },
    dest: null,
    resume() {},
    on(event, cb) { handlers[event] = cb; return res; },
    pipe(dest) { res.dest = dest; return dest; },
    emit(event, argument) { handlers[event]?.(argument); },
    deliver(bytes) { handlers.data?.({ length: bytes }); },
    // What a completed pipe does: end the write stream so it emits 'finish'.
    finish() { res.dest?.end(); },
  };
  return res;
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
  let failuresLeft = options.failWorkers || 0;
  const statuses = [];
  // Each status-bar message with whether its Disposable was disposed: a message held
  // "until the scan settles" is only observable through that.
  const statusMessages = [];
  const errors = [];
  const infos = [];
  const warnings = [];
  // The resolvers for `deferWarnings`, the QuickPick answer queue and what was
  // actually offered, and every output channel ever created. All four exist for
  // the post-teardown continuation tests at the bottom of this file.
  const pendingWarnings = [];
  const pendingInformation = [];
  const informationCalls = [];
  const quickPickAnswers = [];
  const quickPickCalls = [];
  // The options object beside each entry in quickPickCalls, same index.
  const quickPickOptions = [];
  const outputChannels = [];
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
      // CAPTURED. deactivate() disposes the shared channel and nulls the slot, and
      // sharedChannel() used to build a new one whenever the slot was empty — so
      // a "Show detail" clicked after teardown created a document nothing would
      // ever dispose. How many were built is the only way to see that.
      createOutputChannel(name) {
        const channel = {
          name, disposed: false, lines: [],
          appendLine(line) { channel.lines.push(String(line)); },
          clear() { channel.lines.length = 0; },
          show() {},
          dispose() { channel.disposed = true; },
        };
        outputChannels.push(channel);
        return channel;
      },
      // CAPTURED. Whether a push reaches the webview is the only way to see
      // that `dashboard` still points at the live provider — the other
      // observable effects of a refresh happen with or without it.
      registerWebviewViewProvider(_id, instance) { provider = instance; return disposable(); },
      setStatusBarMessage(message) {
        statuses.push(String(message));
        const entry = { message: String(message), disposed: false };
        statusMessages.push(entry);
        // The real API returns a Disposable, and a message held for as long as a scan
        // runs is taken down through it.
        return { dispose() { entry.disposed = true; } };
      },
      showErrorMessage(message) { errors.push(String(message)); },
      showInformationMessage(message, config, ...actions) {
        infos.push(String(message));
        informationCalls.push({ message: String(message), config, actions });
        if (config?.modal && options.deferInformation) return new Promise((resolve) => pendingInformation.push(resolve));
        return Promise.resolve(config?.modal ? options.informationChoice : undefined);
      },
      showWarningMessage(message) {
        warnings.push(String(message));
        // DEFERRED, on request. Six write paths in this extension resume from an
        // awaited dialog, and the window that matters is the one where the user
        // answers AFTER the host tore down. A promise that is already resolved
        // cannot express it: the continuation runs before a test can call
        // deactivate(). `pendingWarnings` hands the resolver back instead.
        if (options.deferWarnings) return new Promise((resolve) => pendingWarnings.push(resolve));
        return Promise.resolve(options.warningChoice);
      },
      // Answers are matched by label / value / id against whatever the caller
      // offered, so a test names the choice a user would click rather than an
      // index into a list it does not build.
      showQuickPick(items, pickOptions) {
        quickPickCalls.push(items);
        quickPickOptions.push(pickOptions);
        if (!quickPickAnswers.length) return Promise.resolve(undefined);
        const want = quickPickAnswers.shift();
        const offered = Array.isArray(items) ? items : [];
        return Promise.resolve(offered.find((item) => (typeof item === 'string' ? item : null) === want
          || item?.label === want || item?.value === want || item?.id === want));
      },
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
          // `options.inspected` maps a key to the per-tier object VS Code's
          // inspect() returns. Held by reference, so a test can change a tier
          // mid-session the way the Settings UI does; absent keys stay `{}`.
          inspect: (key) => (options.inspected && key in options.inspected ? options.inspected[key] : {}),
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
  const originalHomeEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: tempHome, USERPROFILE: tempHome, CODEX_HOME: path.join(tempHome, '.codex') });
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
          // The production deadline is 300000 ms, chosen against the manager's
          // own 180000 ms execFile timeouts. A test cannot wait that out, so it
          // may say how long it is prepared to wait (`workerTimeoutMs`), which
          // replaces whatever the extension passed. Omitted, the EXTENSION'S own
          // `timeoutMs` goes through untouched -- since 2026-10-13 that is the
          // function reading `autoLearn.workerTimeoutSeconds`, which answers
          // undefined while `inspected` holds nothing for it, so the runner's
          // real default applies and every older test here keeps its behaviour.
          timeoutMs: Object.hasOwn(options, 'workerTimeoutMs')
            ? options.workerTimeoutMs : runnerOptions.timeoutMs,
          workerFactory: (_filename, workerOptions) => {
            // These fixtures wedge/count the requested Auto Learn operations.
            // Native gate reconciliation is an independent activation job; let
            // it complete so it cannot consume the scan's synthetic wedge or
            // leave the scan queued behind a worker the fixture never releases.
            if (['codexNativeGates', 'setCodexNativeGates', 'refreshCodexNativeGates']
              .includes(workerOptions.workerData.operation)) return new FakeWorker();
            let worker;
            if (options.wedgeWorker) worker = new WedgedWorker();
            else if (failuresLeft > 0) { failuresLeft -= 1; worker = new FailingWorker(); }
            else worker = new FakeWorker();
            // Which operation it was built for, so a test can tell a second scan from
            // the apply that follows one.
            worker.operation = workerOptions.workerData.operation;
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
  // A SEPARATE statement from the purge, on purpose. `purge()` above is a statement:
  // delete it and nothing goes red, because the next of this file's 27 harnesses simply
  // re-uses the previous one's `os` stub and keeps passing against a home that no longer
  // exists. Asserting the condition here is what makes a dropped purge fail.
  {
    const extensionDir = path.dirname(extensionPath) + path.sep;
    const stale = Object.keys(require.cache)
      .filter((key) => key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir))
      .map((key) => path.basename(key))
      .sort();
    assert.deepEqual(stale, [],
      'project modules are still cached from before this harness installed its mocks, so they '
      + `will resolve an earlier home: ${stale.join(', ')}`);
  }
  const extension = require(extensionPath);
  extension.activate({ subscriptions });
  return {
    commands,
    discoverCalls,
    errors,
    extension,
    httpsRequests,
    infos,
    informationCalls,
    progressRuns,
    warnings,
    memoryDirs,
    outputChannels,
    quickPickAnswers,
    quickPickCalls,
    quickPickOptions,
    reconcilers,
    settings,
    statusBarItems,
    // Answer a dialog that is still on screen. Returns false when nothing is
    // waiting, so a test cannot pass by resolving a prompt that never fired.
    answerWarning(choice) {
      const resolve = pendingWarnings.shift();
      if (!resolve) return false;
      resolve(choice);
      return true;
    },
    answerInformation(choice) {
      const resolve = pendingInformation.shift();
      if (!resolve) return false;
      resolve(choice);
      return true;
    },
    subscriptions,
    intervals,
    watchers,
    // Mutable, so a test can change a setting the way the Settings UI does and
    // then fire the configuration listener.
    settings,
    get provider() { return provider; },
    spawns,
    statuses,
    statusMessages,
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
      for (const [key, value] of Object.entries(originalHomeEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
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

// HOW MANY TIMES the .tmp was unlinked, which the single-slot observable above
// cannot say. `fail` is reachable from five call sites in the transfer across four
// channels (and, since b4271f3, three more in the publish step) and had no
// once-guard, so one destroyed socket cleaned up twice — the second
// unlink throwing ENOENT into a swallowing catch, which is why nothing ever
// noticed. Reset when a fresh .tmp stream opens.
let tmpUnlinkCount = 0;

// Every .tmp path a write stream was opened on, and every .tmp path unlinked, in
// order and never reset by a new stream: two downloads at once are the case the
// per-stream counters above cannot describe. Added 2026-10-13 with the unique temp
// name; each test that reads them empties them first.
const tmpStreamPaths = [];
const tmpUnlinkPaths = [];

// When set, fs.renameSync throws it. The publish step runs inside out.close()'s
// callback, long after the Promise executor returned, so an unwrapped throw
// there is an uncaught exception AND a promise that never settles. EXDEV and an
// antivirus EPERM both reach it on a real box.
//
// Or a FUNCTION, called with the 1-based count of renames aimed at the model so
// far, that returns the error for that attempt or nothing to let it through.
// That is how a holder that refuses N times and then lets go is injected, and
// the moment of a refusal is the one place a test can act "during the wait"
// without racing the retry's timer. Added 2026-10-13 with the publish retry.
let renameFailure = null;

// How many renames the extension aimed at bge-small.onnx, reset when a fresh .tmp
// stream opens. The retry's bound, and "this error is not retried", are counts.
let modelRenames = 0;

function fsHidingRecallModel(realFs) {
  let tmpStreamClosed = false;
  return {
    ...realFs,
    createWriteStream(target, ...rest) {
      const stream = realFs.createWriteStream(target, ...rest);
      if (String(target).endsWith('.tmp')) {
        tmpStreamPaths.push(String(target));
        tmpStreamClosed = false;
        tmpUnlinkObserved = null;
        tmpUnlinkCount = 0;
        modelRenames = 0;
        const realClose = stream.close.bind(stream);
        // Always pass a callback, even when the caller gave none, so the flag flips on the
        // same tick node would have called the caller's own callback on.
        stream.close = (cb) => realClose(() => { tmpStreamClosed = true; if (cb) cb(); });
      }
      return stream;
    },
    renameSync(from, to) {
      if (path.basename(String(to)) === 'bge-small.onnx') modelRenames += 1;
      const failure = typeof renameFailure === 'function' ? renameFailure(modelRenames) : renameFailure;
      if (failure) throw failure;
      return realFs.renameSync(from, to);
    },
    unlinkSync(target) {
      if (String(target).endsWith('.tmp')) {
        tmpUnlinkObserved = { closedFirst: tmpStreamClosed };
        tmpUnlinkCount += 1;
        tmpUnlinkPaths.push(String(target));
      }
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
//
// Rewritten because the old pair was narrower than its own name. `(?<![\w.])execFile\(`
// excluded `.execFile(` BY CONSTRUCTION, so a fifth site written `cp.execFile(` passed in
// silence, and neither half said anything at all about `spawn`, `fork` or `exec`. The
// `trackChild(execFile(` half was a scan for one literal spelling: a correct
// `const child = execFile(...); trackChild(child);` FAILED it, while a `spawn()` walked
// straight past. Two questions now, each falsifiable on its own.
test('every child process the extension starts is handed over to be killable', () => {
  const source = fs.readFileSync(extensionPath, 'utf8');

  // 1. Nothing can spawn that was never imported. This is what closes the `spawn()` hole:
  //    a new spawner has to come through child_process, and the destructure is pinned.
  const requires = source.match(/require\(\s*['"](?:node:)?child_process['"]\s*\)/g) || [];
  assert.equal(requires.length, 1,
    'child_process is imported more than once, or not at all — the spawner census below '
    + 'only judges the import it knows about');
  const destructured = source.match(
    /(?:const|let|var)\s*\{([^}]*)\}\s*=\s*require\(\s*['"](?:node:)?child_process['"]\s*\)/);
  assert.ok(destructured,
    'child_process is no longer imported by destructuring, so this test cannot tell which '
    + 'spawners are in scope');
  assert.deepEqual(
    destructured[1].split(',').map((name) => name.split(':')[0].trim()).filter(Boolean).sort(),
    ['execFile'],
    'a second child_process spawner is in scope. Every child has to reach trackChild, and '
    + 'the site census below only knows how to follow execFile');

  // 2. Every execFile call — member form included — reaches trackChild. Two shapes are
  //    accepted because both are correct: wrapped in place, or assigned and handed over.
  const sites = [];
  const call = /(?:[\w$]+\s*\.\s*)?\bexecFile\s*\(/g;
  let hit;
  while ((hit = call.exec(source)) !== null) {
    const lineStart = source.lastIndexOf('\n', hit.index) + 1;
    const lineEnd = source.indexOf('\n', hit.index);
    sites.push({
      index: hit.index,
      line: source.slice(0, hit.index).split('\n').length,
      text: source.slice(lineStart, lineEnd === -1 ? source.length : lineEnd),
    });
  }
  // Five since 2026-10-14: the gates panel's runRecallStep (list, edit, compile) is the fifth.
  // Six since 2026-10-19: the Claude memory card's Search (runClaudeMemorySearch).
  // Seven since 2026-10-19: the open-threads compile (compileThreads).
  assert.equal(sites.length, 7, `the seven known spawn sites, found ${sites.length}`);

  const untracked = [];
  let wrapped = 0;
  let assigned = 0;
  for (const site of sites) {
    if (/trackChild\(\s*(?:[\w$]+\s*\.\s*)?execFile\s*\(/.test(site.text)) { wrapped += 1; continue; }
    const binding = site.text.match(
      /(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$]+\s*\.\s*)?execFile\s*\(/);
    if (binding
      && new RegExp(String.raw`trackChild\(\s*${binding[1]}\s*[,)]`).test(source.slice(site.index))) {
      assigned += 1;
      continue;
    }
    untracked.push(`extension.js:${site.line}  ${site.text.trim()}`);
  }
  assert.deepEqual(untracked, [],
    'an execFile child is never handed to trackChild, so deactivate cannot kill it:\n  '
    + untracked.join('\n  '));
  // Witness, so a regex that stopped matching anything cannot report a clean sweep: the
  // classification has to have actually recognised every site it passed.
  assert.equal(wrapped + assigned, sites.length,
    `every site must be classified; recognised ${wrapped} wrapped + ${assigned} assigned `
    + `of ${sites.length}`);

  // ONE tracked child is let finish by deactivate, on purpose (2026-10-14): a memory gate edit,
  // which a kill part way leaves half-written with nothing put back (runRecallStep). It is
  // still tracked and still bounded; killLiveChildren skips only what finishingChildren holds,
  // and only runRecallStep's `finish` puts anything there. test/gates-panel.test.js shows a
  // reload during the edit leaves it running and kills the list before it.
  assert.equal((source.match(/finishingChildren\.add\(/g) || []).length, 1, 'one place lets a child finish');
  assert.match(source, /if \(finish\) finishingChildren\.add\(child\);/);
  assert.match(source, /\[\.\.\.liveChildren\]\.filter\(\(child\) => !finishingChildren\.has\(child\)\)/);
});

// EVERY DEADLINE ENDS THE WHOLE TREE (2026-10-14). execFile's own `timeout` kills the
// one child it holds, and each of these children is a launcher on Windows: the npm
// codex.cmd is cmd.exe -> node, and the venv python.exe's interpreter is its child.
// So no site may pass execFile a `timeout`; each takes its deadline from
// endTreeAfter (src/exec-resolve.js), which tree-kills the root while it lives, and
// keeps the length it had. test/exec-resolve.test.js shows the grandchild surviving
// the one kill and not the other.
test('every execFile site takes its deadline from endTreeAfter, never from execFile\'s own timeout', () => {
  const source = fs.readFileSync(extensionPath, 'utf8');
  const deadlines = [];
  const call = /(?:[\w$]+\s*\.\s*)?\bexecFile\s*\(/g;
  let hit;
  while ((hit = call.exec(source)) !== null) {
    const line = source.slice(source.lastIndexOf('\n', hit.index) + 1, source.indexOf('\n', hit.index));
    const label = `extension.js:${source.slice(0, hit.index).split('\n').length}`;
    // MUTATION: put `timeout: 30000` back into execFileCaptured's options and drop
    // its endTreeAfter. Both checks below fail. Confirmed 2026-10-14.
    assert.match(line, /endTreeAfter\(\s*trackChild\(\s*execFile\s*\(/, `${label} is not bounded by endTreeAfter`);
    // The options are everything between the call and its callback's arrow.
    const head = source.slice(hit.index, source.indexOf('=>', hit.index));
    assert.doesNotMatch(head, /\btimeout\s*:/, `${label} passes execFile its own timeout`);
    const close = /\}\)\),\s*(\d+)\)/.exec(source.slice(hit.index));
    deadlines.push(close ? Number(close[1]) : null);
  }
  // The four lengths the sites had as execFile timeouts, in file order: the recall
  // rebuild and the recall sync, the execpolicy check, the gate compile. Then the gates
  // panel's recall.py steps (2026-10-14), at the gate compile's 60 s. The Claude memory search
  // (2026-10-19) sits second, after the rebuild it is written beside, at 120 s. The open-threads
  // compile (2026-10-19) follows the gate compile it is modelled on, at the same 60 s.
  assert.deepEqual(deadlines, [180000, 120000, 180000, 30000, 60000, 60000, 60000]);
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

test('the local-settings watchers have exactly one drain disposer, and it is the live one',
  TEST_TIMEOUT, async (t) => {
    // registerLocalWatchers registered TWO disposers, byte for byte identical and
    // closing over the same `watchers` array. Whichever ran first emptied it, so
    // the other was a no-op over an empty array for the life of the window: two
    // entries in context.subscriptions that between them could only ever do one
    // thing.
    //
    // Runtime cannot tell a dead duplicate from a live one — that is exactly why
    // it survived — so the count is taken over the REGISTERED closures rather
    // than over an effect. The assertion below then disposes the one it counted,
    // which is what stops the count from measuring the wrong thing if the drain
    // is ever rewritten.
    const home = tempHome(t);
    const app = harness(home);
    try {
      const local = app.watcherFor('.claude/settings.local.json');
      assert.equal(local.disposed, false, 'precondition: the local-settings watcher is live');

      const drains = app.subscriptions.filter((entry) =>
        typeof entry?.dispose === 'function' && /watchers\.pop\(\)/.test(String(entry.dispose)));
      assert.equal(drains.length, 1,
        `${drains.length} watcher-drain disposers are registered. All but the first are dead `
        + 'code: the first to run empties the array they all share');

      drains[0].dispose();
      assert.equal(local.disposed, true,
        'the disposer this test counted does not drain the local-settings watchers, so the '
        + 'count above was measuring something else');
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

// THE POSITIVE CONTROL for the two `!statuses.some(... 'already running')`
// assertions below and further down this file. Without it they were negative-
// only, and nothing in the suite ever saw that message at all: deleting the
// busy-latch short-circuit from runAutoLearnScan, or simply rewording the
// string, left both of them green while the thing they claim to be watching had
// ceased to exist. A pair of assertions that can only agree with each other is
// not coverage.
//
// Kept immediately above them so a future reword has to touch this test too.
test('a manual scan started while another is in flight reports "already running"', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  // wedgeWorker, because the latch is only observably set while a scan is
  // genuinely unfinished. A FakeWorker answers on the next tick and the window
  // closes before a second scan can be dispatched, which would make this test
  // agree with the negative ones for the wrong reason.
  const app = harness(home, { settings: { 'autoLearn.enabled': true }, wedgeWorker: true });
  try {
    // Fired, NOT awaited: a wedged scan never settles.
    const wedged = app.commands.get('permission-wildcarding.autoLearnScan')();
    await tick(200);
    assert.equal(app.workers.length, 1,
      'precondition: a scan is really in flight, not merely believed to be');

    app.statuses.length = 0;
    // Fired, NOT awaited, and the resolution recorded on the side. A scan that
    // is ALLOWED to start never settles under this harness, so awaiting the
    // second call directly would hang the runner instead of failing when the
    // latch is gone — which is how the first draft of this test behaved under
    // its own mutation. The refusal is observable immediately; the latch check
    // runs before runAutoLearnScan's first await.
    const settled = [];
    const second = app.commands.get('permission-wildcarding.autoLearnScan')();
    second.then((value) => settled.push(value), (error) => settled.push(error));
    await tick(200);

    assert.ok(app.statuses.some((m) => m.includes('already running')),
      'a manual scan refused because one is in flight must SAY so; a silent '
      + 'no-op reads as "the scan found nothing"');
    assert.equal(app.workers.length, 1,
      'and it was refused, not started: no second worker was built');
    assert.deepEqual(settled, [null],
      'the refusal resolved null; a scan that had been allowed to start would '
      + 'still be pending here');

    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await Promise.allSettled([wedged, second]);
  } finally {
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
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
    //
    // Meaningful only because the test directly above proves this message is
    // still emitted when a scan really is in flight.
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

test('a same-realm re-activate repeats a once-per-activation warning', TEST_TIMEOUT, async (t) => {
  // warnOnce dedupes on a module-scope Set that its own comment says is "per
  // activation", and nothing cleared it: neither activate() nor deactivate()
  // touched it, so an extension disable/enable or upgrade, which re-activates in
  // the same realm, never repeated a warning the previous activation had given.
  //
  // `backupMirrorPath: '~'` is the one reachable warnOnce caller: it names the
  // home DIRECTORY, so mirrorBackupPath warns and falls back. It is only asked
  // when a backup is really written, and backupPolicy short-circuits when the
  // high-water union is unchanged, so each window below adds an allow entry the
  // backup has never held before running the pass.
  const messages = captureConsoleError(t);
  const home = tempHome(t);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const grant = (...extra) => fs.writeFileSync(settingsPath, JSON.stringify(
    { permissions: { allow: ['Bash(rg *)', ...extra], deny: [] } }, null, 2) + '\n');
  const warned = () => messages.filter((message) =>
    /backupMirrorPath "~" is the home directory/.test(message)).length;
  // A user setting (inspected as `globalValue`): the key is machine-scoped and read from that tier
  // alone since F7 (2026-10-14).
  const app = harness(home, { settings: { backupMirrorPath: '~' }, inspected: { backupMirrorPath: { globalValue: '~' } } });
  try {
    grant('Bash(zzfirst *)');
    await app.commands.get('permission-wildcarding.runNow')();
    grant('Bash(zzfirst *)', 'Bash(zzsecond *)');
    await app.commands.get('permission-wildcarding.runNow')();
    assert.equal(warned(), 1,
      'precondition: the warning fires, and only once however many writes ask in one activation');

    await app.extension.deactivate();
    app.reactivate();
    grant('Bash(zzfirst *)', 'Bash(zzsecond *)', 'Bash(zzthird *)');
    await app.commands.get('permission-wildcarding.runNow')();
    assert.equal(warned(), 2,
      'the re-activated extension never repeated the warning: the Set outlived deactivate');
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

// The busy latch's half of the same generation test, which nothing could make fail.
//
// Found on 2026-09-25 while proving the runner half above: deleting
// `generation === activationGeneration &&` from the LATCH line left the whole suite
// green, while deleting it from the RUNNER line one statement earlier killed the test
// above. Two guards, written together, commented as a pair (— "Same generation test
// as the busy latch below") and only one of them falsifiable.
//
// What the missing half costs: the predecessor's continuation clears a latch the
// SUCCESSOR's in-flight scan is holding, so the "already running" refusal stops
// refusing and a second worker is dispatched against a scan that has not finished.
// The manager serialises the policy WRITE behind its own file lock, so this is not a
// corruption; it is the concurrency guard the extension advertises, silently off.
//
// TWO MUTATIONS, and this kills both, because the rule needs both halves. Drop the
// generation test from runAutoLearnScan’s own `finally`, or from deactivate’s copy of
// it, and the assertion below fails with the message it carries. The extension fix
// landed with this test on 2026-09-25; before it, only the RUNNER half of the pair
// could be made to fail at all.
test('a wedged predecessor does not release the successor\u2019s busy latch', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const app = harness(home, { settings: { 'autoLearn.enabled': true }, wedgeWorker: true });
  try {
    const wedged = app.commands.get('permission-wildcarding.autoLearnScan')();
    await tick(200);
    assert.equal(app.workers.length, 1, 'precondition: the predecessor really is scanning');
    const predecessorWorker = app.workers[0];

    const teardown = app.extension.deactivate();
    app.reactivate();

    const second = app.commands.get('permission-wildcarding.autoLearnScan')();
    await tick(200);
    assert.equal(app.workers.length, 2,
      'witness:busy-latch-generation -- the successor started a scan of its own');

    // The wedged job answers, the predecessor's drain completes, and its continuation
    // resumes into a realm the successor now owns.
    predecessorWorker.release();
    await Promise.allSettled([wedged, teardown]);
    await tick(200);

    // The successor's scan is STILL wedged, so its latch must still be set.
    app.statuses.length = 0;
    const settled = [];
    const third = app.commands.get('permission-wildcarding.autoLearnScan')();
    third.then((value) => settled.push(value), (error) => settled.push(error));
    await tick(200);

    assert.ok(app.statuses.some((message) => message.includes('already running')),
      'the predecessor\u2019s continuation released the successor\u2019s busy latch, so a third '
      + 'scan was let past one still in flight');
    assert.equal(app.workers.length, 2,
      'and it was refused rather than started: no third worker was built');
    assert.deepEqual(settled, [null], 'the refusal resolved null');

    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await Promise.allSettled([second, third]);
  } finally {
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await app.dispose();
  }
});

// ── Review says something, every time (2026-10-14) ─────────────────────────────
//
// Reported: Review on the Auto Learn card, and nothing visible happened. Its prerequisite
// scan was runAutoLearnScan(false), which returns null IN SILENCE when another scan holds
// the latch, when the background failure backoff is armed, and when the worker throws
// (console.error only), and Review returned on that null. When the scan did run and left
// nothing reviewable, the answer was a corner toast, which Do Not Disturb hides. The
// counts half of the same report is in test/dashboard-view.test.js.

// Codex off, so `claude` is the only pending target, as it was in the reported state.
const REVIEW_SETTINGS = { 'autoLearn.enabled': true, 'autoLearn.codexScope': 'off' };

// The reported shape in the manager's own persisted form: two auto-safe and two review
// families that an existing allow rule covers, and one still under the threshold. Written
// BEFORE harness(), whose activation runs the wildcarding pass over settings.json (a fixed
// point here) and whose purge drops the manager module this requires.
function seedCoveredFamilies(home) {
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({
    permissions: { allow: ['Bash(git *)', 'PowerShell(git *)', 'Bash(rg *)'], deny: [] },
  }, null, 2) + '\n');
  const { createAutoLearnManager } = require('../src/auto-learn-manager');
  const statePath = createAutoLearnManager({
    home, workspaceRoot: path.join(home, 'workspace'), codexRulesPath: null,
  }).status().paths.state;
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
  ];
  fs.mkdirSync(path.dirname(statePath), { recursive: true });
  fs.writeFileSync(statePath, JSON.stringify({
    version: 1, mode: 'recommend', threshold: 3,
    candidates: Object.fromEntries(families.map((item) => [item.key, item])),
    observationHashes: {}, cursors: {},
    applied: { claude: [], codex: [] }, reviewed: { claude: [], codex: [] },
    codexTargets: {}, managedClaude: {}, lastScanAt: null, lastScanStats: null, lastApplication: null,
  }, null, 2) + '\n');
}

const modalOf = (app) => app.informationCalls.find((call) => call.config?.modal);

test('Review clicked while a scan is running waits for it, then answers, on one worker', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  seedCoveredFamilies(home);
  // wedgeWorker, so the scan Review finds really is unfinished until this test says so.
  const app = harness(home, { settings: REVIEW_SETTINGS, wedgeWorker: true });
  try {
    // A BACKGROUND scan holds the latch: the configuration listener's debounced rescan.
    app.fireConfigChange('permissionWildcarding.autoLearn');
    await tick(300);
    assert.equal(app.workers.length, 1, 'precondition: a background scan is really in flight');

    // Fired, NOT awaited: it is waiting on a scan that has not settled.
    //
    // MUTATION: restore the old prerequisite, `runAutoLearnScan(false, true)` and return
    // on its null. No progress is shown and the first assertion below fails. MUTATION:
    // keep the progress but skip the wait in scanBeforeUserAction (`if (false)` for the
    // in-flight test). Review is refused by the latch and returns before the scan
    // settles, so "keeps showing it while it waits" fails. Both confirmed 2026-10-14.
    const review = app.commands.get('permission-wildcarding.autoLearnReview')();
    const progress = app.statusMessages.find((entry) => /scanning history before review/.test(entry.message));
    assert.ok(progress, 'Review shows progress the instant it is clicked');
    await tick(200);
    assert.equal(progress.disposed, false, 'and keeps showing it while it waits');
    assert.equal(modalOf(app), undefined, 'precondition: nothing has answered yet');

    app.workers[0].release();
    await review;

    const modal = modalOf(app);
    assert.ok(modal, 'Review answered once the scan it waited on settled');
    assert.match(modal.message, /no candidates are ready for review/);
    assert.equal(app.workers.length, 1, 'it waited on that scan rather than dispatching a second worker');
    assert.equal(progress.disposed, true, 'and the progress message comes down when the scan settles');
  } finally {
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await app.dispose();
  }
});

test('Review during the background failure backoff still scans and answers', TEST_TIMEOUT, async (t) => {
  const logged = captureConsoleError(t);
  const home = tempHome(t);
  seedCoveredFamilies(home);
  const app = harness(home, { settings: REVIEW_SETTINGS, failWorkers: 1 });
  try {
    app.fireConfigChange('permissionWildcarding.autoLearn');
    await tick(400);
    assert.equal(app.workers.length, 1, 'precondition: a background scan ran');
    assert.ok(logged.some((message) => /Auto Learn scan failed/.test(message)),
      'precondition: and failed, which arms the backoff');

    await app.commands.get('permission-wildcarding.autoLearnReview')();

    // MUTATION: drop `!userInitiated` from the backoff test in runAutoLearnScan. Review's
    // scan is refused by the backoff, nothing is dispatched and nothing answers.
    // Confirmed 2026-10-14.
    assert.equal(app.workers.length, 2, 'a click is not a watcher event: Review scanned anyway');
    assert.ok(modalOf(app), 'and answered');
  } finally {
    await app.dispose();
  }
});

test('a Review whose own scan fails says so', TEST_TIMEOUT, async (t) => {
  captureConsoleError(t);
  const home = tempHome(t);
  seedCoveredFamilies(home);
  const app = harness(home, { settings: REVIEW_SETTINGS, failWorkers: 1 });
  try {
    await app.commands.get('permission-wildcarding.autoLearnReview')();
    assert.equal(app.workers.length, 1, 'precondition: Review dispatched its own scan');
    // MUTATION: reduce the catch's toast condition to `if (manual)`. The failure goes to
    // console.error alone, as it did for Review before 2026-10-14. Confirmed 2026-10-14.
    assert.deepEqual(app.errors, ['Auto Learn scan failed: history unreadable'],
      'a scan the user asked for that fails is shown, not only logged');
    assert.equal(modalOf(app), undefined, 'and nothing is offered as if the scan had worked');
  } finally {
    await app.dispose();
  }
});

test('a Review waiting on a scan that then fails says so', TEST_TIMEOUT, async (t) => {
  const logged = captureConsoleError(t);
  const home = tempHome(t);
  seedCoveredFamilies(home);
  const app = harness(home, { settings: REVIEW_SETTINGS, wedgeWorker: true });
  try {
    app.fireConfigChange('permissionWildcarding.autoLearn');
    await tick(300);
    assert.equal(app.workers.length, 1, 'precondition: a background scan is really in flight');
    const review = app.commands.get('permission-wildcarding.autoLearnReview')();
    await tick(100);
    app.workers[0].fail('history unreadable');
    await review;

    // MUTATION: drop the error branch of scanBeforeUserAction's wait. The joined scan's
    // failure is then logged by its background owner and nothing else. Confirmed 2026-10-14.
    assert.deepEqual(app.errors, ['Auto Learn scan failed: history unreadable'],
      'the waiting Review reports the failure of the scan it waited on');
    assert.ok(logged.some((message) => /Auto Learn scan failed/.test(message)),
      'and the background scan that owned it still logs, exactly as before');
    assert.equal(app.workers.length, 1, 'still one worker');
  } finally {
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await app.dispose();
  }
});

test('an empty Review is a modal with the covered count, and Show covered lists them read-only',
  TEST_TIMEOUT, async (t) => {
    const home = tempHome(t);
    seedCoveredFamilies(home);
    const settingsPath = path.join(home, '.claude', 'settings.json');
    const app = harness(home, { settings: REVIEW_SETTINGS, informationChoice: 'Show covered' });
    try {
      const before = fs.readFileSync(settingsPath, 'utf8');
      await app.commands.get('permission-wildcarding.autoLearnReview')();

      // MUTATION: restore the toast, `showInformationMessage(message)` with no options.
      // No modal is found and the first assertion fails. Confirmed 2026-10-14.
      const modal = modalOf(app);
      assert.ok(modal, 'the empty answer is modal: a toast is easy to miss and hidden under Do Not Disturb');
      assert.equal(modal.message,
        'Auto Learn: no candidates are ready for review (4 already covered by existing allow rules — hidden).');
      assert.match(modal.config.detail, /4 command families are already covered by an allow rule/);
      assert.match(modal.config.detail, /1 command family is still being observed/);
      assert.deepEqual(modal.actions, ['Show covered'], 'no managed policy here, so no Show blocked');

      assert.equal(app.quickPickCalls.length, 1, 'Show covered opened a list');
      assert.deepEqual(app.quickPickCalls[0].map((item) => [item.label, item.description]).sort(), [
        ['Bash(git log *)', 'covered by Bash(git *)'],
        ['Bash(git status *)', 'covered by Bash(git *)'],
        ['Bash(rg *)', 'covered by Bash(rg *)'],
        ['PowerShell(git status *)', 'covered by PowerShell(git *)'],
      ], 'every hidden family, each with the allow rule that covers it');
      const pickOptions = app.quickPickOptions[0];
      assert.ok(!pickOptions.canPickMany, 'read-only: no checkboxes');
      assert.match(pickOptions.title, /4 already covered .*read-only/);
      assert.equal(app.workers.length, 1, 'nothing was applied: the scan is the only worker');
      assert.equal(fs.readFileSync(settingsPath, 'utf8'), before, 'and settings.json is untouched');
    } finally {
      await app.dispose();
    }
  });

// Apply safe ran the same prerequisite and returned on the same null.
test('Apply safe clicked while a scan is running waits for it, then applies', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  seedCoveredFamilies(home);
  const app = harness(home, { settings: REVIEW_SETTINGS, wedgeWorker: true });
  try {
    app.fireConfigChange('permissionWildcarding.autoLearn');
    await tick(300);
    assert.equal(app.workers.length, 1, 'precondition: a background scan is really in flight');

    // MUTATION: restore `runAutoLearnScan(false, true)` and its null return in
    // applyAutoLearnSafe. No progress is shown, so the first assertion fails; past it,
    // the latch refuses the scan and no apply is ever dispatched. Confirmed 2026-10-14.
    const apply = app.commands.get('permission-wildcarding.autoLearnApplySafe')();
    assert.ok(app.statusMessages.some((entry) => /scanning history before applying/.test(entry.message)),
      'Apply safe shows progress the instant it is clicked');
    await tick(200);
    app.workers[0].release();
    await tick(200);
    assert.deepEqual(app.workers.map((worker) => worker.operation), ['scan', 'apply'],
      'it waited on the running scan, then applied: no second scan, and no silent return');
    app.workers[1].release();
    await apply;
    assert.ok(app.infos.includes('Auto Learn: no unapplied safe candidates meet the threshold.'),
      'and reported the outcome');
  } finally {
    for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
    await app.dispose();
  }
});

// The control for the five above: everything they changed is the user-initiated path,
// and a background scan must behave exactly as it did. It passes with or without them.
// MUTATION: make the debounced rescan user-initiated (`runAutoLearnScan(false, true)` in
// scheduleAutoLearn). The failure is toasted instead of logged and the backoff no longer
// refuses the next scan, so this fails. Confirmed 2026-10-14.
test('a background scan that fails stays silent and keeps its backoff', TEST_TIMEOUT, async (t) => {
  const logged = captureConsoleError(t);
  const home = tempHome(t);
  seedCoveredFamilies(home);
  const app = harness(home, { settings: REVIEW_SETTINGS, failWorkers: 1 });
  try {
    app.fireConfigChange('permissionWildcarding.autoLearn');
    await tick(400);
    assert.equal(app.workers.length, 1, 'precondition: a background scan ran');
    assert.ok(logged.some((message) => /Auto Learn scan failed — .*history unreadable/.test(message)),
      'its failure is logged, as before');
    assert.deepEqual(app.errors, [], 'and not toasted: nobody asked for this scan');
    assert.deepEqual(app.statuses.filter((message) => /Auto Learn/.test(message)), [],
      'no status-bar message either');
    assert.equal(app.informationCalls.length, 0);

    app.fireConfigChange('permissionWildcarding.autoLearn');
    await tick(400);
    assert.equal(app.workers.length, 1, 'the backoff still refuses the next background scan');
  } finally {
    await app.dispose();
  }
});

test('a worker still wedged at teardown is failed on its deadline and then reaped',
  TEST_TIMEOUT, async (t) => {
    // The leak the two tests above had to work AROUND. Both of them end by calling
    // release() on every worker, because without that the drain never finishes —
    // and a suite that has to un-wedge its own fixture to reach teardown cannot
    // then say anything about what teardown does to a worker that stays wedged.
    //
    // Nothing did. `WedgedWorker.terminated` was written at both of its sites and
    // read by no assertion, so the one thing the flag exists to prove was never
    // proved: a thread blocked in a synchronous fs call (statSync against a dead
    // network mount) emits no 'message', no 'error' and no 'exit', its job promise
    // stayed pending, deactivate()'s Promise.allSettled over those jobs never
    // resolved, and the terminate pass AFTER that drain never ran. One live thread
    // per reload, plus a `context.subscriptions` that never drains.
    //
    // Terminating earlier is not the fix and is not what this asserts. The
    // drain-before-terminate order is deliberate (autoLearnWorkerRunner.js:151-154#instant):
    // a worker between two policy writes must reach its own result or the
    // manager's JS rollback is lost. The deadline settles the JOB as a failure,
    // which is all the drain needs, and leaves the reaping exactly where it was.
    //
    // The sibling test above is right that terminate() is the wrong observable for
    // a CLEAN exit — a worker that exits by itself is never terminated by design.
    // This is the other case, and here it is the only observable there is.
    const home = tempHome(t);
    const app = harness(home, {
      settings: { 'autoLearn.enabled': true },
      wedgeWorker: true,
      workerTimeoutMs: 150,
    });
    try {
      const wedged = app.commands.get('permission-wildcarding.autoLearnScan')();
      await tick(50);
      assert.equal(app.workers.length, 1, 'precondition: a worker was built and never answered');
      assert.equal(app.workers[0].terminated, false,
        'precondition: nothing has reaped it yet, so a later true means teardown did it');

      let drained = false;
      const teardown = app.extension.deactivate().then(() => { drained = true; });
      // Deliberately NOT awaited. With no deadline this never resolves, and an
      // await here would spend the file timeout instead of failing by name.
      await tick(1500);

      assert.equal(drained, true,
        'deactivate() never resolved: its drain awaits a job promise that cannot settle, so '
        + 'context.subscriptions never drains either');
      assert.equal(app.workers[0].terminated, true,
        'the wedged thread survived the extension host — one more live worker per reload');

      await Promise.allSettled([wedged, teardown]);
    } finally {
      for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
      await app.dispose();
    }
  });

// `autoLearn.workerTimeoutSeconds`, end to end through the REAL runner. Until
// 2026-10-13 the deadline was reachable only through the env var, because
// getConfiguration() cannot read a key the manifest does not declare. The
// extension builds one runner per activation and the configuration listener never
// rebuilds it, so the setting arrives as a function the runner re-reads per
// operation. These drive a manual scan against a worker that never answers and
// read the deadline back out of the error the scan reports; no config event is
// fired, so a second value can only be seen if it is re-read.
const DEADLINE_KEY = 'autoLearn.workerTimeoutSeconds';

// A scan that never settles must fail by name here, not spend the file timeout.
async function manualScanWithin(app, ms) {
  let settled = false;
  const scan = Promise.resolve(app.commands.get('permission-wildcarding.autoLearnScan')())
    .finally(() => { settled = true; });
  await Promise.race([scan, tick(ms)]);
  return { settled, scan, error: app.errors.at(-1) || '' };
}

// The VS Code half of the contract, which no harness can see: the stubbed
// getConfiguration() answers for any key, declared or not, and has no notion of
// scope. Undeclared, the real one cannot read the key at all; window-scoped, a
// repository's .vscode/settings.json could set 0 and turn the backstop off.
test('the manifest declares the deadline setting machine-scoped, with the runner\'s own default', () => {
  const extensionDir = path.dirname(extensionPath);
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
  const setting = manifest.contributes?.configuration?.properties?.[`permissionWildcarding.${DEADLINE_KEY}`];
  assert.ok(setting, 'an undeclared key is unreadable through getConfiguration()');
  assert.equal(setting.scope, 'machine',
    'any wider scope lets a cloned repository disable the deadline from its own settings file');
  assert.equal(setting.type, 'number');
  assert.equal(setting.minimum, 0);
  const runner = fs.readFileSync(path.join(extensionDir, 'autoLearnWorkerRunner.js'), 'utf8');
  const runnerDefault = Number(/const DEFAULT_WORKER_TIMEOUT_MS = (\d+);/.exec(runner)?.[1]);
  assert.ok(runnerDefault > 0, 'precondition: the runner default was found');
  assert.equal(setting.default * 1000, runnerDefault,
    'the Settings UI must show the default the runner actually applies when the key is unset');
});

async function withDeadlineEnv(value, body) {
  const previous = process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS;
  if (value === undefined) delete process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS;
  else process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS = value;
  try { return await body(); } finally {
    if (previous === undefined) delete process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS;
    else process.env.PERMISSION_WILDCARDING_WORKER_TIMEOUT_MS = previous;
  }
}

test('the worker deadline setting reaches the runner, and an edit applies to the next scan',
  TEST_TIMEOUT, (t) => withDeadlineEnv(undefined, async () => {
    const home = tempHome(t);
    const inspected = { [DEADLINE_KEY]: { defaultValue: 300, globalValue: 0.08 } };
    // Background scans off, so the only worker built is the one each manual
    // scan asks for.
    const app = harness(home, {
      settings: { 'autoLearn.enabled': false }, wedgeWorker: true, inspected,
    });
    try {
      const first = await manualScanWithin(app, 2000);
      assert.equal(first.settled, true,
        'the scan never settled: the setting did not reach the runner, so the 300 s default applied');
      assert.match(first.error, /did not answer within 80ms/,
        'seconds from the user tier, converted to ms, are the deadline');

      // Edited in Settings. Same runner, no configuration event.
      inspected[DEADLINE_KEY] = { defaultValue: 300, globalValue: 0.04 };
      const second = await manualScanWithin(app, 2000);
      assert.match(second.error, /did not answer within 40ms/,
        `a deadline frozen at the runner's construction ignores the edit — got "${second.error}"`);
      assert.equal(app.workers.length, 2, 'precondition: one worker per scan');
    } finally {
      for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
      await app.dispose();
    }
  }));

test('an unset or workspace-only deadline setting leaves the env override in force, and an explicit 0 disables it',
  TEST_TIMEOUT, (t) => withDeadlineEnv('60', async () => {
    const home = tempHome(t);
    const inspected = {};
    // get() answers the manifest default, as VS Code's does. A provider that
    // read get() would hand the runner 300000 ms and silently outrank the env var.
    const app = harness(home, {
      settings: { 'autoLearn.enabled': false, [DEADLINE_KEY]: 300 }, wedgeWorker: true, inspected,
    });
    try {
      const unset = await manualScanWithin(app, 2000);
      assert.match(unset.error, /did not answer within 60ms/,
        `an unset setting must leave the env override in force — got "${unset.error}"`);

      // A repository's .vscode/settings.json trying to switch the backstop off.
      // The key is machine-scoped and only the user tier is read.
      inspected[DEADLINE_KEY] = { defaultValue: 300, workspaceValue: 0 };
      const workspace = await manualScanWithin(app, 2000);
      assert.equal(workspace.settled, true,
        'a workspace value disabled the deadline: only globalValue may be honoured');
      assert.match(workspace.error, /did not answer within 60ms/);

      // The user's own 0 is a value, not a miss: it outranks the env var.
      inspected[DEADLINE_KEY] = { defaultValue: 300, globalValue: 0 };
      const errorsBefore = app.errors.length;
      const off = await manualScanWithin(app, 300);
      assert.equal(off.settled, false,
        'an explicit 0 must disable the deadline; five times the env value has passed');
      assert.equal(app.errors.length, errorsBefore, 'and nothing was reported as a timeout');
      app.workers.at(-1).release();
      await off.scan;
    } finally {
      for (const worker of app.workers) if (typeof worker.release === 'function') worker.release();
      await app.dispose();
    }
  }));

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

// Cancel was the only way to stop this transfer, and Cancel is a button the user
// presses. The three below are the failures nobody presses a button for.

test('teardown cancels the 32MB download instead of letting it publish a model',
  TEST_TIMEOUT, async (t) => {
    // deactivate() kills four execFile children by name and then awaits the Auto
    // Learn drain. It did nothing at all about this one, because `liveChildren`
    // holds ChildProcess handles and a download is a request handle plus two
    // streams, all closure-local. So a reload during the transfer left it
    // running to completion and renameSync-ing bge-small.onnx into ~/.claude on
    // behalf of a host that no longer existed — the same class of defect as the
    // gate compile rewriting CLAUDE.md after teardown, and the last member of it.
    const { app, home, rebuild } = await startModelDownload(t);
    try {
      app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
      const body = liveBodyResponse();
      app.httpsRequests[1].respond(body);
      assert.equal(app.httpsRequests[1].destroyed, false, 'precondition: the body is transferring');
      app.errors.length = 0;

      const teardown = app.extension.deactivate();

      assert.equal(app.httpsRequests[1].destroyed, true,
        'teardown left the 32MB transfer running against a torn-down extension host');
      const outcome = await Promise.race([
        rebuild.then(() => 'settled'),
        tick(2000).then(() => 'still pending after 2000ms'),
      ]);
      assert.equal(outcome, 'settled',
        `the aborted download never settled its progress notification — got "${outcome}"`);

      const dest = path.join(home, '.claude', 'wildcarding', 'models', 'bge-small.onnx');
      assert.equal(fs.existsSync(dest), false,
        'a torn-down host published a recall model into ~/.claude');
      assert.deepEqual(
        app.errors.filter((m) => m.includes('download failed')), [],
        'teardown raised an error toast from an extension that is going away — the user did '
        + 'not cancel anything, they reloaded');
    } finally {
      await app.dispose();
    }
  });

test('a transfer that completes during teardown does not publish the model',
  TEST_TIMEOUT, async (t) => {
    // Aborting the handle is not enough on its own, and this is the window it
    // misses: the body has already been fully received, so destroying the
    // request emits nothing — there is no live socket left to error — while the
    // write stream's 'finish' is already queued. The close callback then runs
    // against a torn-down host and renames bge-small.onnx into ~/.claude anyway.
    //
    // Same reasoning as every execFile callback in this file carrying its own
    // `deactivated` check rather than trusting the kill.
    const { app, home, rebuild } = await startModelDownload(t);
    try {
      app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
      const body = liveBodyResponse();
      const carrier = app.httpsRequests[1];
      carrier.respond(body);
      body.deliver(6 * 1024 * 1024);
      // A request whose response is already complete: destroy() marks it and
      // fires nothing, because there is nothing left to interrupt.
      carrier.destroy = () => { carrier.destroyed = true; };

      await app.extension.deactivate();
      assert.equal(carrier.destroyed, true, 'precondition: teardown still reached the handle');
      body.finish();

      const outcome = await Promise.race([
        rebuild.then(() => 'settled'),
        tick(2000).then(() => 'still pending after 2000ms'),
      ]);
      assert.equal(outcome, 'settled', `the download never settled — got "${outcome}"`);
      const dest = path.join(home, '.claude', 'wildcarding', 'models', 'bge-small.onnx');
      assert.equal(fs.existsSync(dest), false,
        'a completed transfer published a recall model into ~/.claude on behalf of an '
        + 'extension host that had already gone');
    } finally {
      await app.dispose();
    }
  });

test('one socket error fails the download once, not once per channel', TEST_TIMEOUT, async (t) => {
  // `fail` had no once-guard and is reachable from five call sites in the transfer
  // across four independent channels: httpsGetFollow's error, a non-200, the response
  // stream's 'error', the short-file check, and the write stream's 'error'. A
  // destroyed socket fires more than one of them — the request errors and the
  // response it was feeding errors too — so a single failure showed the user two
  // identical error toasts and unlinked the .tmp twice, the second throwing
  // ENOENT into the swallowing catch where nothing could see it.
  const { app, rebuild, cancel } = await startModelDownload(t);
  try {
    app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
    const body = liveBodyResponse();
    app.httpsRequests[1].respond(body);
    app.errors.length = 0;

    // Channel 1: the request is destroyed, which fires its 'error' handler and
    // reaches fail() through httpsGetFollow's callback.
    cancel();
    // Channel 2: the response stream feeding the pipe errors out from the same
    // dead socket. On a real box these arrive microseconds apart.
    body.emit('error', new Error('socket hang up'));
    await rebuild;

    const reported = app.errors.filter((m) => m.includes('download failed'));
    assert.equal(reported.length, 1,
      `one failure produced ${reported.length} error toasts: ${reported.join(' | ')}`);
    assert.equal(tmpUnlinkCount, 1,
      `one failure unlinked the .tmp ${tmpUnlinkCount} times; the extra ENOENT is swallowed, `
      + 'so the double-cleanup is invisible from outside');
  } finally {
    await app.dispose();
  }
});

test('a rename that throws fails the download instead of hanging the notification',
  TEST_TIMEOUT, async (t) => {
    // fs.renameSync sits inside out.close()'s callback, which runs long after the
    // Promise executor returned. Unwrapped, a throw there is not a rejection —
    // it is an uncaught exception, and the promise it was meant to settle stays
    // pending, so the progress notification spins for the life of the window with
    // no way to dismiss it and no error anywhere. EXDEV (RECALL_MODEL_DIR on
    // another volume) and an antivirus EPERM both reach it.
    renameFailure = Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
    t.after(() => { renameFailure = null; });
    const { app, home, rebuild } = await startModelDownload(t);
    try {
      app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
      const body = liveBodyResponse();
      app.httpsRequests[1].respond(body);
      // Past the 5MB "this is not an HTML error page" floor, so the publish step
      // is actually reached rather than short-circuiting into the size check.
      body.deliver(6 * 1024 * 1024);
      app.errors.length = 0;
      body.finish();

      const outcome = await Promise.race([
        rebuild.then(() => 'settled'),
        tick(2000).then(() => 'still pending after 2000ms'),
      ]);
      assert.equal(outcome, 'settled',
        `a failed rename left the progress notification spinning forever — got "${outcome}"`);
      assert.ok(app.errors.some((m) => m.includes('EXDEV')),
        `the rename failure was never reported: ${JSON.stringify(app.errors)}`);
      assert.equal(modelRenames, 1, 'WITNESS an error no holder produces is not retried');
      const models = path.join(home, '.claude', 'wildcarding', 'models');
      assert.deepEqual(fs.readdirSync(models).filter((f) => f.endsWith('.tmp')), [],
        'a failed publish left its partial file behind, which reads as "model present"');
    } finally {
      await app.dispose();
    }
  });

// ── the publish rename against a momentary holder ─────────────────────────────
//
// On Windows a rename is refused while anything holds a handle in its way, and
// Defender and the indexer open a file milliseconds after it is written. Until
// 2026-10-13 the publish step made ONE attempt, so a scanner's moment on the
// just-closed .tmp failed the whole 32MB download (measured on the development
// box: a holder without delete sharing makes this exact rename fail EBUSY, and
// the same rename lands once it lets go). It now retries the same rename on
// EPERM, EACCES and EBUSY, ten attempts 20..180 ms apart, on timers. The
// refusals are injected, so these run the same on every platform.

// A download driven up to the publish step: redirected, past the 5MB floor, and
// one body.finish() away from the rename. `carrier` is the request that carried
// the body, for the tests that need it to behave like a finished request.
async function downloadAtPublish(t) {
  const started = await startModelDownload(t);
  started.app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
  const body = liveBodyResponse();
  const carrier = started.app.httpsRequests[1];
  carrier.respond(body);
  body.deliver(6 * 1024 * 1024);
  started.app.errors.length = 0;
  const models = path.join(started.home, '.claude', 'wildcarding', 'models');
  return {
    ...started, body, carrier,
    dest: path.join(models, 'bge-small.onnx'),
    leftovers: () => fs.readdirSync(models).filter((f) => f.endsWith('.tmp')),
    // Bounded well past the 0.9 s of waits, so "still pending" means hung.
    settled: (ms = 5000) => Promise.race([
      started.rebuild.then(() => 'settled'),
      tick(ms).then(() => `still pending after ${ms}ms`),
    ]),
  };
}
const holderError = (code) => Object.assign(new Error(`${code}: injected holder, rename`), { code });

for (const [code, refusals] of [['EPERM', 3], ['EBUSY', 1], ['EACCES', 1]]) {
  test(`a model rename refused ${refusals}x with ${code} by a holder that lets go lands on a retry`,
    TEST_TIMEOUT, async (t) => {
      // Whether the event loop turned between the first two attempts: an
      // Atomics.wait between them would pass every other assertion here while
      // freezing the extension-host thread for the whole wait.
      let turned = null, turnedBetween = null;
      renameFailure = (attempt) => {
        if (attempt === 2) turnedBetween = turned;
        if (attempt === 1) { turned = false; setImmediate(() => { turned = true; }); }
        return attempt <= refusals ? holderError(code) : null;
      };
      t.after(() => { renameFailure = null; });
      const box = await downloadAtPublish(t);
      try {
        box.body.finish();
        assert.equal(await box.settled(), 'settled', 'the retried publish never settled');
        assert.ok(modelRenames > refusals,
          'WITNESS the same rename, repeated past every injected refusal, is what landed');
        assert.equal(turnedBetween, true, 'WITNESS the wait yields the extension-host thread instead of blocking it');
        assert.equal(fs.existsSync(box.dest), true, `WITNESS ${code} from a holder that lets go does not fail the download`);
        assert.deepEqual(box.leftovers(), [], 'the .tmp was renamed into place, not copied');
        assert.deepEqual(box.app.errors.filter((m) => m.includes('download failed')), [],
          `a refusal that cleared was still reported as a failure: ${JSON.stringify(box.app.errors)}`);
        // The download resolved TRUE, and this is how that shows here: the harness
        // hides every bge-small.onnx outside the toolbox dir, so rebuildRecall's
        // post-download probe cannot see the file that just landed and says so.
        // A download that resolved false returns before reaching that probe.
        assert.ok(box.app.errors.some((m) => m.includes('reported success')),
          `the download did not resolve as a success: ${JSON.stringify(box.app.errors)}`);
      } finally {
        await box.app.dispose();
      }
    });
}

test('a holder that never lets go fails the download after a bounded retry, with the .tmp removed',
  TEST_TIMEOUT, async (t) => {
    renameFailure = () => holderError('EPERM');
    t.after(() => { renameFailure = null; });
    const box = await downloadAtPublish(t);
    try {
      box.body.finish();
      assert.equal(await box.settled(), 'settled', 'a persistent holder left the notification spinning');
      assert.equal(modelRenames, 10, 'WITNESS the retry is bounded (ten attempts, 0.9 s of waits)');
      assert.ok(box.app.errors.some((m) => m.includes('download failed') && m.includes('EPERM')),
        `the persistent refusal was not reported: ${JSON.stringify(box.app.errors)}`);
      assert.equal(fs.existsSync(box.dest), false, 'WITNESS no model is published when the rename never lands');
      assert.deepEqual(box.leftovers(), [], 'the failed download left its .tmp behind');
      assert.equal(tmpUnlinkCount, 1, 'the cleanup ran once, as for any other failure');
    } finally {
      await box.app.dispose();
    }
  });

// The wait is new state, and three things can end a download during it. None of
// them may be outwaited: a retry that landed afterwards would publish a model
// the user cancelled, into a host that is gone, or after its failure was shown.
test('a Cancel pressed while the publish is being refused stops the retry instead of publishing',
  TEST_TIMEOUT, async (t) => {
    const box = await downloadAtPublish(t);
    // The body has arrived, so this request is finished, and destroying a
    // finished request emits nothing: Cancel cannot reach `fail` through it.
    box.carrier.destroy = () => { box.carrier.destroyed = true; };
    renameFailure = (attempt) => {
      if (attempt > 1) return null; // the holder lets go: a second attempt WOULD land
      box.cancel();
      return holderError('EBUSY');
    };
    t.after(() => { renameFailure = null; });
    try {
      box.body.finish();
      assert.equal(await box.settled(), 'settled');
      assert.equal(box.carrier.destroyed, true, 'precondition: Cancel reached the handle');
      assert.equal(fs.existsSync(box.dest), false, 'WITNESS a retry outwaited the Cancel and published the model');
      assert.equal(modelRenames, 1, 'no rename is attempted after Cancel');
      assert.ok(box.app.errors.some((m) => m.includes('cancelled')),
        `the cancellation was not reported: ${JSON.stringify(box.app.errors)}`);
      assert.deepEqual(box.leftovers(), [], 'the cancelled download left its .tmp behind');
    } finally {
      await box.app.dispose();
    }
  });

test('a teardown while the publish is being refused publishes nothing and says nothing',
  TEST_TIMEOUT, async (t) => {
    const box = await downloadAtPublish(t);
    box.carrier.destroy = () => { box.carrier.destroyed = true; };
    let teardown = null;
    renameFailure = (attempt) => {
      if (attempt > 1) return null;
      teardown = box.app.extension.deactivate();
      return holderError('EPERM');
    };
    t.after(() => { renameFailure = null; });
    try {
      box.body.finish();
      assert.equal(await box.settled(), 'settled', 'a teardown during the wait left the download pending');
      await teardown;
      assert.equal(fs.existsSync(box.dest), false,
        'WITNESS a retry outwaited the teardown and published a model into ~/.claude for a host that is gone');
      assert.equal(modelRenames, 1, 'no rename is attempted after teardown');
      assert.deepEqual(box.app.errors.filter((m) => m.includes('download failed')), [],
        'a torn-down host raised an error toast');
      assert.deepEqual(box.leftovers(), [], 'the abandoned download left its .tmp behind');
    } finally {
      await box.app.dispose();
    }
  });

// The same teardown, with a same-realm re-activate inside the 20 ms wait (2026-10-14).
// activate() clears `deactivated`, so to the old host's retry timer the host looked
// live. What still stopped the rename was the transfer's `cancelled` flag, set by
// deactivate's abort; what did NOT stop was the failure toast, "recall model download
// failed — cancelled", raised in the successor's window for a download it never ran.
test('a fast re-activate while the publish is being refused neither publishes the old download nor reports it to the new window',
  TEST_TIMEOUT, async (t) => {
    const box = await downloadAtPublish(t);
    box.carrier.destroy = () => { box.carrier.destroyed = true; };
    let teardown = null;
    renameFailure = (attempt) => {
      if (attempt > 1) return null; // the holder lets go: a retry WOULD land
      teardown = box.app.extension.deactivate();
      box.app.reactivate();
      return holderError('EPERM');
    };
    t.after(() => { renameFailure = null; });
    try {
      box.body.finish();
      assert.equal(await box.settled(), 'settled', 'the old download was left pending');
      await teardown;
      // NOT independently falsifiable today, and said so rather than claimed: dropping
      // `generation !== activationGeneration` from publish leaves this green (run
      // 2026-10-14), because deactivate's abortLiveTransfers also sets the handle's
      // sticky `cancelled` flag, which the retry reads next and fails on. The
      // generation check is the one that does not depend on the transfer still
      // being registered when the host goes; the toast below is what the old code
      // actually got wrong.
      assert.equal(fs.existsSync(box.dest), false,
        'WITNESS the predecessor’s retry published a model after a re-activate');
      assert.equal(modelRenames, 1, 'no rename is attempted for a predecessor');
      // MUTATION: drop the generation test from fail's toast. "download failed —
      // extension deactivated" reaches the successor. Confirmed 2026-10-14.
      assert.deepEqual(box.app.errors.filter((m) => m.includes('download failed')), [],
        'the predecessor’s failure was reported in the successor’s window');
      assert.deepEqual(box.leftovers(), [], 'the abandoned download left its .tmp behind');
    } finally {
      await box.app.dispose();
    }
  });

test('a download another channel failed during the wait is not retried into place',
  TEST_TIMEOUT, async (t) => {
    const box = await downloadAtPublish(t);
    renameFailure = (attempt) => {
      if (attempt > 1) return null;
      // Any of `fail`'s other channels; the response stream is the simplest to fire.
      box.body.emit('error', new Error('socket hang up'));
      return holderError('EBUSY');
    };
    t.after(() => { renameFailure = null; });
    try {
      box.body.finish();
      assert.equal(await box.settled(), 'settled');
      // Let the retry's timer come due: the failure settled the download first.
      await tick(100);
      assert.equal(modelRenames, 1, 'WITNESS a rename was attempted after the download had already failed');
      assert.equal(fs.existsSync(box.dest), false);
      assert.equal(box.app.errors.filter((m) => m.includes('download failed')).length, 1,
        `one failure, one toast: ${JSON.stringify(box.app.errors)}`);
      assert.deepEqual(box.leftovers(), []);
    } finally {
      await box.app.dispose();
    }
  });

// ── two downloads at once ─────────────────────────────────────────────────────
//
// RECALL_MODEL_HOME is one directory for every VS Code window, and rebuildRecall
// does not stop a second download in the same window either. Until 2026-10-13 the
// temp name was the fixed `bge-small.onnx.tmp`, so two downloads at once opened one
// file twice, and the first to fail unlinked the other's partial file. Two
// rebuildRecall calls in one harness are two downloads in one process, the harder
// case for a per-writer name: the pid is shared, so only the random part separates them.
const MODEL_TMP_NAME = new RegExp(`^bge-small\\.onnx\\.${process.pid}\\.[0-9a-f]{12}\\.tmp$`);

test('two downloads at once write two temp files, and the one that fails removes only its own',
  TEST_TIMEOUT, async (t) => {
    const home = tempHome(t);
    const corpus = memoryCorpus(t);
    fakeRecallEnvironment(t, { model: false });
    const app = harness(home, { memoryDir: corpus, warningChoice: 'Download' });
    tmpStreamPaths.length = 0;
    tmpUnlinkPaths.length = 0;
    const models = path.join(home, '.claude', 'wildcarding', 'models');
    const leftovers = () => fs.readdirSync(models).filter((f) => f.endsWith('.tmp')).sort();
    try {
      const first = app.commands.get('permission-wildcarding.rebuildRecall')();
      const second = app.commands.get('permission-wildcarding.rebuildRecall')();
      await tick(50);
      assert.equal(app.httpsRequests.length, 2, 'precondition: both downloads started');
      app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
      app.httpsRequests[1].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
      const body = liveBodyResponse();
      app.httpsRequests[2].respond(body);
      body.deliver(6 * 1024 * 1024);

      // MUTATION: restore `const tmp = dest + '.tmp'`. Both streams open one path, so this
      // fails first, and with it gone the next assertion fails too: the second download's
      // cleanup unlinks the first one's file. Confirmed 2026-10-13.
      // MUTATION: drop the random part (`${dest}.${process.pid}.tmp`). One process, one
      // pid, one name again, and this fails. Confirmed 2026-10-13.
      assert.equal(new Set(tmpStreamPaths).size, 2, `two downloads shared a temp file: ${tmpStreamPaths.join(', ')}`);
      for (const tmp of tmpStreamPaths) {
        assert.equal(path.dirname(tmp), models, 'the temp file sits beside the model, so the publish stays a rename');
        assert.match(path.basename(tmp), MODEL_TMP_NAME, 'the name is `<dest>.<pid>.<random>.tmp`');
      }

      // The second download fails while the first is still transferring.
      app.httpsRequests[3].respond({ statusCode: 500, headers: {}, resume() {} });
      await second;
      assert.ok(app.errors.some((m) => m.includes('HTTP 500')), `the failure was not reported: ${JSON.stringify(app.errors)}`);
      assert.deepEqual(tmpUnlinkPaths, [tmpStreamPaths[1]], 'the failed download unlinked something other than its own file');
      assert.deepEqual(leftovers(), [path.basename(tmpStreamPaths[0])],
        'the transfer still running lost its partial file to the other download\'s cleanup');

      app.errors.length = 0;
      body.finish();
      await first;
      assert.equal(fs.existsSync(path.join(models, 'bge-small.onnx')), true, 'the surviving download published the model');
      assert.deepEqual(leftovers(), [], 'its temp file was renamed into place');
      assert.deepEqual(app.errors.filter((m) => m.includes('download failed')), [],
        `the surviving download reported a failure: ${JSON.stringify(app.errors)}`);
    } finally {
      await app.dispose();
    }
  });

test('a failed download leaves another download\'s temp file alone', TEST_TIMEOUT, async (t) => {
  // The other window's file, in the shape that window's download writes, made before
  // this one starts. Cleanup unlinks the name THIS download wrote, never a pattern.
  const { app, home, rebuild } = await startModelDownload(t);
  const models = path.join(home, '.claude', 'wildcarding', 'models');
  const foreign = path.join(models, 'bge-small.onnx.4242.0123456789ab.tmp');
  fs.writeFileSync(foreign, 'another window is still writing this');
  tmpUnlinkPaths.length = 0;
  try {
    app.httpsRequests[0].respond(redirectTo('https://cdn.example.invalid/model_quantized.onnx'));
    app.httpsRequests[1].respond({ statusCode: 404, headers: {}, resume() {} });
    await rebuild;
    assert.ok(app.errors.some((m) => m.includes('HTTP 404')));
    // MUTATION: make `fail` unlink every `bge-small.onnx.*.tmp` in the directory. The
    // other window's file goes with it and this fails. Confirmed 2026-10-13.
    assert.equal(fs.existsSync(foreign), true, 'a failed download removed another download\'s temp file');
    assert.equal(tmpUnlinkPaths.length, 1, 'one cleanup, of its own file');
    assert.match(path.basename(tmpUnlinkPaths[0]), MODEL_TMP_NAME);
    assert.deepEqual(fs.readdirSync(models).filter((f) => f.endsWith('.tmp')), [path.basename(foreign)]);
  } finally {
    await app.dispose();
  }
});

// ── stale temp sweep ──────────────────────────────────────────────────────────
//
// A download whose host is KILLED (a crash, a power loss) cannot run deactivate()'s unlink,
// so its `<dest>.<pid>.<hex>.tmp` partial, and a pre-2026-10-13 build's fixed
// `bge-small.onnx.tmp`, stay in the one shared model directory forever. Since 2026-10-13 each
// download first sweeps any `<dest>.*.tmp` older than a day (sweepStaleModelTemps), but never
// a younger one — RECALL_MODEL_HOME is one directory for every window, so a fresh temp may be
// another window's live transfer.
const DAY_MS = 24 * 60 * 60 * 1000;

// Start a download with the model directory pre-seeded. `plant` writes a file and back-dates
// its mtime by `ageMs`. Returns once the sweep has run (the download has issued its first
// request). The download is left in flight; the caller disposes.
async function startDownloadWithSeededModelDir(t, seed) {
  const home = tempHome(t);
  const corpus = memoryCorpus(t);
  fakeRecallEnvironment(t, { model: false });
  const app = harness(home, { memoryDir: corpus, warningChoice: 'Download' });
  const models = path.join(home, '.claude', 'wildcarding', 'models');
  fs.mkdirSync(models, { recursive: true });
  const plant = (name, ageMs) => {
    const full = path.join(models, name);
    fs.writeFileSync(full, 'partial');
    const when = (Date.now() - ageMs) / 1000;
    fs.utimesSync(full, when, when);
    return name;
  };
  seed(plant);
  tmpStreamPaths.length = 0;
  const rebuild = app.commands.get('permission-wildcarding.rebuildRecall')();
  await tick(50);
  assert.equal(app.httpsRequests.length, 1, 'precondition: the download started, so the sweep ran');
  return { app, models, rebuild, present: () => new Set(fs.readdirSync(models)) };
}

test('a download sweeps the stale temp files a killed host left, and leaves live and unrelated ones', TEST_TIMEOUT, async (t) => {
  let oldWriter, oldLegacy, freshWriter, unrelated;
  const box = await startDownloadWithSeededModelDir(t, (plant) => {
    oldWriter = plant('bge-small.onnx.9999.aaaaaaaaaaaa.tmp', 2 * DAY_MS);   // a crashed older download
    oldLegacy = plant('bge-small.onnx.tmp', 2 * DAY_MS);                     // a pre-2026-10-13 build's fixed name
    freshWriter = plant('bge-small.onnx.4242.bbbbbbbbbbbb.tmp', 60 * 1000);  // another window, transferring now
    unrelated = plant('bge-small.onnx.keep.notatmp', 2 * DAY_MS);           // not a `.tmp`
    plant('scratch.tmp', 2 * DAY_MS);                                        // a `.tmp`, but not a model temp
  });
  try {
    const present = box.present();
    // MUTATION: drop the `sweepStaleModelTemps(modelDir, tmp)` call. The old partials survive
    // and these two fail. Confirmed 2026-10-13.
    // MUTATION: invert the age test (`<` for `>`). The old ones are kept and the fresh one is
    // swept, so both these and the "kept" block fail. Confirmed 2026-10-13.
    assert.ok(!present.has(oldWriter), 'a day-old per-writer partial from a killed host is swept');
    assert.ok(!present.has(oldLegacy), 'the legacy fixed `bge-small.onnx.tmp` is swept when old');
    // MUTATION: sweep unconditionally (drop the age comparison). The fresh file goes with it
    // and this fails. Confirmed 2026-10-13.
    assert.ok(present.has(freshWriter), 'a minute-old temp may be another window\'s live transfer and is kept');
    // MUTATION: match on `endsWith('.tmp')` alone (drop the `startsWith` model-name guard).
    // `scratch.tmp` is swept and this fails. Confirmed 2026-10-13.
    assert.ok(present.has('scratch.tmp'), 'an unrelated `.tmp` is not a model temp and is left alone');
    assert.ok(present.has(unrelated), 'a non-`.tmp` model file is left alone');
    // The download's own temp (this process, just opened) is present and never a sweep target.
    assert.equal(box.app.httpsRequests.length >= 1, true);
    const own = tmpStreamPaths.map((p) => path.basename(p)).find((n) => MODEL_TMP_NAME.test(n));
    assert.ok(own && box.present().has(own), 'the download\'s own temp is written and kept');
    await box.app.dispose();
    // SETTLE before the temp home is removed. dispose() aborts the transfer, and the abort
    // unlinks the download's own temp inside the write stream's close() callback, which runs
    // after dispose() returns. The cancel test above awaits `rebuild` for the same reason.
    // Without it the home's teardown raced that callback: green locally on Node 24, and
    // ENOTEMPTY on the models directory on CI's Node 20 / windows-latest leg (run
    // 38508110502, 2026-10-14).
    await box.rebuild;
    assert.ok(!fs.existsSync(path.join(box.models, own)), 'the aborted download removed its own temp');
  } finally {
    await box.app.dispose();
    await box.rebuild;
  }
});

test('a download keeps a fresh legacy temp: an old build may be mid-transfer', TEST_TIMEOUT, async (t) => {
  // The fixed name is swept only when stale; a current download by a pre-2026-10-13 build in
  // another window writes the same fixed name, and the age guard is what tells them apart.
  let freshLegacy;
  const box = await startDownloadWithSeededModelDir(t, (plant) => {
    freshLegacy = plant('bge-small.onnx.tmp', 5 * 60 * 1000);                // 5 minutes old
  });
  try {
    // MUTATION: give MODEL_TMP_STALE_MS a tiny value (e.g. 1000). The fresh legacy temp is
    // swept and this fails. Confirmed 2026-10-13.
    assert.ok(box.present().has(freshLegacy), 'a fresh legacy temp is a possible live transfer and is kept');
  } finally {
    // Settle the aborted download before teardown; see the test above.
    await box.app.dispose();
    await box.rebuild;
  }
});

// ── six awaited dialogs, all of them resuming into a write ────────────────────
//
// A notification or QuickPick outlives the extension host that raised it: VS Code
// keeps it on screen, the user answers whenever they notice it, and the
// continuation runs against whatever the module-level state has become. This
// class has now been fixed three times in this file — ensureGates, then
// ensureGuidance ("flipping guidance.enabled after teardown rewrote CLAUDE.md
// from 1802 bytes to 24"), then the schedulers — and each fix guarded one
// function while its siblings kept the hole.
//
// These six are the rest. Every one writes settings.json, the high-water backup,
// or the instruction files, and none of them could be reached from this file
// until the harness above grew a QuickPick and a deferrable warning.
//
// Each test drives the SAME path twice: once live, to prove the command really
// does write — without which the post-teardown assertion passes for the wrong
// reason — and once after deactivate().
const GATES_BODY = '## Standing gates (1 memories, managed)\n\n- **Test gate.** Pass: nothing.\n';

function instructionHome(t, { gates = false } = {}) {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'),
    '# my own notes\n\nnothing managed here yet\n');
  if (gates) fs.writeFileSync(path.join(home, '.claude', 'gates.generated.md'), GATES_BODY);
  return home;
}
const readClaudeMd = (home) => fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');

test('toggleGuidance after teardown leaves the instruction files alone', TEST_TIMEOUT, async (t) => {
  // ensureGuidance carries this guard and says why. toggleGuidance calls the same
  // setGuidanceAll against the same two files, behind a modal and a config
  // update — two awaits, either of which can span a teardown — and did not.
  const home = instructionHome(t);
  const settings = { 'guidance.enabled': true };

  const live = harness(home, { settings: { ...settings }, warningChoice: 'Remove' });
  let installed;
  try {
    installed = readClaudeMd(home);
    assert.match(installed, /BEGIN permission-wildcarding/, 'activation installed the block');
    await live.commands.get('permission-wildcarding.toggleGuidance')();
    assert.doesNotMatch(readClaudeMd(home), /BEGIN permission-wildcarding: shell style/,
      'witness:toggle-teardown -- the live toggle did not remove the block, so this test '
      + 'cannot tell a guard from a no-op');
  } finally {
    await live.dispose();
  }

  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), installed);
  const app = harness(home, { settings: { ...settings }, warningChoice: 'Remove' });
  try {
    const before = readClaudeMd(home);
    await app.extension.deactivate();
    await app.commands.get('permission-wildcarding.toggleGuidance')();
    assert.equal(readClaudeMd(home), before,
      'witness:toggle-teardown -- a torn-down host rewrote the managed block out of CLAUDE.md');
  } finally {
    await app.dispose();
  }
});

test('toggleGates after teardown leaves the instruction files alone', TEST_TIMEOUT, async (t) => {
  // The widest window of the three: up to four awaits in front of the write — a
  // compile prompt, the compile, a modal, the config update.
  const home = instructionHome(t, { gates: true });
  const settings = { 'gates.enabled': true, 'guidance.enabled': false };

  const live = harness(home, { settings: { ...settings }, warningChoice: 'Remove' });
  let installed;
  try {
    installed = readClaudeMd(home);
    assert.match(installed, /BEGIN permission-wildcarding: memory gates/,
      'activation installed the gates block');
    await live.commands.get('permission-wildcarding.toggleGates')();
    assert.doesNotMatch(readClaudeMd(home), /BEGIN permission-wildcarding: memory gates/,
      'witness:toggle-teardown -- the live toggle did not remove the gates block');
  } finally {
    await live.dispose();
  }

  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), installed);
  const app = harness(home, { settings: { ...settings }, warningChoice: 'Remove' });
  try {
    const before = readClaudeMd(home);
    await app.extension.deactivate();
    await app.commands.get('permission-wildcarding.toggleGates')();
    assert.equal(readClaudeMd(home), before,
      'witness:toggle-teardown -- a torn-down host removed the gates block');
  } finally {
    await app.dispose();
  }
});

test('the wildcard picker after teardown prunes nothing', TEST_TIMEOUT, async (t) => {
  // Two awaited dialogs in front of a write to settings.json AND to the
  // high-water backup, and the comment at that call site says the pair is not
  // recoverable: the prune drops the entry from the backup on purpose, so a later
  // restore will not bring it back.
  const home = tempHome(t);
  const settingsPath = path.join(home, '.claude', 'settings.json');
  const read = () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.allow;

  const live = harness(home, { warningChoice: 'Remove' });
  try {
    live.quickPickAnswers.push('Bash(rg *)');
    await live.commands.get('permission-wildcarding.showWildcards')();
    assert.deepEqual(read(), [],
      'witness:picker-teardown -- the live picker pruned nothing, so this test cannot tell a '
      + 'guard from a broken command');
  } finally {
    await live.dispose();
  }

  fs.writeFileSync(settingsPath,
    `${JSON.stringify({ permissions: { allow: ['Bash(rg *)'], deny: [] } }, null, 2)}\n`);
  const app = harness(home, { warningChoice: 'Remove' });
  try {
    await app.extension.deactivate();
    app.quickPickAnswers.push('Bash(rg *)');
    await app.commands.get('permission-wildcarding.showWildcards')();
    assert.deepEqual(read(), ['Bash(rg *)'],
      'witness:picker-teardown -- a torn-down host pruned an allow entry from settings.json and '
      + 'from the only backup of it');
  } finally {
    await app.dispose();
  }
});

// The sharpest of the six. deactivate() nulls `autoLearnManager`, and
// getAutoLearnManager() BUILDS A NEW ONE when the slot is empty — so the usual
// "the retainer is gone, nothing can happen" reasoning is exactly backwards here:
// a continuation arriving after teardown constructs a live manager against a dead
// host and writes CLAUDE.md through it. Two QuickPicks upstream make the window
// wide.
function derivedGuidanceHome(t) {
  const home = tempHome(t);
  const workspace = path.join(home, 'workspace');
  fs.mkdirSync(workspace, { recursive: true });
  const script = path.join(workspace, 'build.ps1');
  const records = [{ type: 'session_meta', payload: { id: 'derived', cwd: workspace } }];
  // 60 edits of one gated path: over the threshold that protects the context
  // budget, which is what makes `batch-file-edits` derivable at all. The cwd is
  // inside the workspace root the harness reports, or the scan filters every
  // observation out and the review comes back empty.
  for (let index = 0; index < 60; index += 1) {
    records.push(
      { type: 'assistant',
        message: { role: 'assistant',
          content: [{ type: 'tool_use', id: `e${index}`, name: 'Edit', input: { file_path: script } }] } },
      { type: 'user',
        message: { role: 'user',
          content: [{ type: 'tool_result', tool_use_id: `e${index}`, is_error: false, content: 'ok' }] } },
    );
  }
  const history = path.join(home, '.claude', 'projects', 'p', 'session.jsonl');
  fs.mkdirSync(path.dirname(history), { recursive: true });
  fs.writeFileSync(history, `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), '# my own instructions\n\nread these first\n');
  fs.writeFileSync(path.join(home, '.claude', 'remote-settings.json'),
    `${JSON.stringify({ permissions: { ask: ['Edit(**/*.ps1)'], deny: [], allow: [] } }, null, 2)}\n`);
  // Seeded through the REAL learner, at the state path the extension resolves to
  // from the same home and workspace root. A stubbed review would prove nothing:
  // what is under test is what the continuation does with a manager it builds
  // itself.
  // eslint-disable-next-line global-require
  const { createAutoLearnManager } = require('../src/auto-learn-manager');
  createAutoLearnManager({ home, workspaceRoot: workspace }).scan();
  return home;
}

// Killing mutations: truncate the full-body modal; remove its post-response
// teardown guard. Each must fail this test after the live Accept write is proved.
test('derived guidance accepted after teardown writes no instruction file', TEST_TIMEOUT, async (t) => {
  const home = derivedGuidanceHome(t);
  const settings = { 'autoLearn.enabled': true, 'guidance.enabled': false, 'gates.enabled': false };

  const live = harness(home, { settings: { ...settings }, informationChoice: 'Accept' });
  let notes;
  try {
    notes = readClaudeMd(home);
    live.quickPickAnswers.push('batch-file-edits');
    await live.commands.get('permission-wildcarding.derivedGuidance')();
    const modal = live.informationCalls.find((call) => call.config?.modal);
    assert.ok(modal, 'witness:derived-teardown -- the full-body decision modal must appear');
    const offered = live.quickPickCalls[0].find((item) => item.id === 'batch-file-edits');
    assert.equal(modal.config.detail, offered.detail + '\n\nCurrently not yet decided. '
      + 'Accept installs this instruction; Decline removes it and stops offering it; '
      + 'Reset removes it and makes it undecided.',
      'witness:derived-teardown -- the entire standing instruction must be visible before Accept');
    assert.deepEqual(modal.actions, ['Accept', 'Decline', 'Reset']);
    assert.match(readClaudeMd(home), /batch-file-edits \(derived\)/,
      'witness:derived-teardown -- the live command wrote no derived block, so this test cannot '
      + 'tell a guard from a path that never reaches the write');
  } finally {
    await live.dispose();
  }

  fs.writeFileSync(path.join(home, '.claude', 'CLAUDE.md'), notes);
  const app = harness(home, { settings: { ...settings }, deferInformation: true });
  try {
    app.quickPickAnswers.push('batch-file-edits');
    const command = app.commands.get('permission-wildcarding.derivedGuidance')();
    await tick(0);
    assert.ok(app.informationCalls.some((call) => call.config?.modal),
      'witness:derived-teardown -- the decision must be awaiting an actual modal response');
    await app.extension.deactivate();
    assert.equal(app.answerInformation('Accept'), true,
      'witness:derived-teardown -- the deferred full-body modal must still be waiting');
    await command;
    assert.equal(readClaudeMd(home), notes,
      'witness:derived-teardown -- a torn-down host built a fresh Auto Learn manager and wrote a '
      + 'standing instruction into CLAUDE.md through it');
  } finally {
    await app.dispose();
  }
});

test('Codex hook confirmation after extension deactivation cannot install the callback', TEST_TIMEOUT, async (t) => {
  const home = tempHome(t);
  const file = path.join(home, '.codex', 'hooks.json');
  const live = harness(home, { informationChoice: 'Configure hook' });
  try {
    await live.commands.get('permission-wildcarding.codexHook')();
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop.length, 1,
      'WITNESS live extension command must install the configured hook');
  } finally { await live.dispose(); }
  fs.unlinkSync(file);
  const app = harness(home, { deferInformation: true });
  try {
    const pending = app.commands.get('permission-wildcarding.codexHook')();
    await tick(0);
    assert.match(app.informationCalls.find((call) => call.config?.modal)?.config.detail || '', /codex-stop-hook\.js/);
    await app.extension.deactivate();
    assert.equal(app.answerInformation('Configure hook'), true);
    await pending;
    assert.equal(fs.existsSync(file), false,
      'WITNESS deactivation must dispose the hook UI before a late confirmation can write');
  } finally { await app.dispose(); }
});

// The two arms of the managed-policy prompt. It fires from activation and both
// answers write — "Re-assert them" merges the whole backup into settings.json,
// "Forget them" rewrites the only copy of the high-water mark — so the answer has
// to be deferred past deactivate() for the window to exist at all.
function policyPromptHome(t) {
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2)}\n`);
  const backupDir = path.join(home, '.claude', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'allow-list.latest.json'),
    `${JSON.stringify({ allow: ['Bash(tokei *)', 'Bash(fd *)'], deny: [] }, null, 2)}\n`);
  return { home, backupPath: path.join(backupDir, 'allow-list.latest.json') };
}

for (const [choice, label] of [['Re-assert them', 're-assert'], ['Forget them', 'forget']]) {
  test(`the managed-policy prompt answered ${label} after teardown writes nothing`,
    TEST_TIMEOUT, async (t) => {
      const { home, backupPath } = policyPromptHome(t);
      const settingsPath = path.join(home, '.claude', 'settings.json');
      const app = harness(home, { deferWarnings: true });
      try {
        const settingsBefore = fs.readFileSync(settingsPath, 'utf8');
        const backupBefore = fs.readFileSync(backupPath, 'utf8');
        assert.ok(app.warnings.some((message) => /missing from settings\.json/.test(message)),
          `witness:policy-teardown -- the prompt never fired: ${JSON.stringify(app.warnings)}`);

        await app.extension.deactivate();
        assert.equal(app.answerWarning(choice), true,
          'witness:policy-teardown -- nothing was waiting on an answer, so the continuation under '
          + 'test never ran');
        await tick(100);

        assert.equal(fs.readFileSync(settingsPath, 'utf8'), settingsBefore,
          `witness:policy-teardown -- "${choice}" wrote settings.json from a torn-down host`);
        assert.equal(fs.readFileSync(backupPath, 'utf8'), backupBefore,
          `witness:policy-teardown -- "${choice}" rewrote the high-water backup from a torn-down host`);
      } finally {
        await app.dispose();
      }
    });
}

test('"Show detail" after teardown creates no channel nobody will dispose', TEST_TIMEOUT, async (t) => {
  // sharedChannel() built a new OutputChannel whenever its slot was empty, and
  // deactivate() disposes the channel and empties that slot — the same
  // empty-slot-means-build-a-new-one shape as getAutoLearnManager and
  // getAutoLearnWorkerRunner, both of which carry a `deactivated` check for it.
  // A BULK loss, not the two-entry one above: "Show detail" only exists on the
  // notification that follows an automatic restore, and that needs five missing
  // entries to clear the bulk-loss line. Answering the small-loss prompt with
  // "Show detail" matches neither of its arms and reaches nothing — measured,
  // not guessed: that is what the first version of this test did, and the
  // mutation survived it.
  const home = tempHome(t);
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2)}\n`);
  const backupDir = path.join(home, '.claude', 'backups');
  fs.mkdirSync(backupDir, { recursive: true });
  fs.writeFileSync(path.join(backupDir, 'allow-list.latest.json'),
    `${JSON.stringify({
      allow: ['Bash(tokei *)', 'Bash(fd *)', 'Bash(jq *)', 'Bash(yq *)', 'Bash(bat *)', 'Bash(delta *)'],
      deny: [],
    }, null, 2)}\n`);

  const app = harness(home, { deferWarnings: true });
  try {
    assert.ok(app.warnings.some((message) => /policy change detected/.test(message)),
      `witness:channel-teardown -- the Show detail prompt never fired: ${JSON.stringify(app.warnings)}`);
    await app.extension.deactivate();
    const built = app.outputChannels.length;
    for (const channel of app.outputChannels) {
      assert.equal(channel.disposed, true, 'precondition: teardown disposed what it had');
    }

    assert.equal(app.answerWarning('Show detail'), true);
    await tick(100);

    assert.equal(app.outputChannels.length, built,
      'witness:channel-teardown -- a torn-down host created an OutputChannel with no owner and no '
      + 'disposer');
  } finally {
    await app.dispose();
  }
});
