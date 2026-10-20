'use strict';

// THE DASHBOARD NEVER ASKS CODEX ON THE EXTENSION HOST THREAD (2026-10-14).
//
// d5200f9 made the dashboard count include a trusted project's
// `<project>/.codex/rules`, and to know which project folders Codex trusts it
// asked Codex: a spawnSync of the config worker, which starts `codex app-server`,
// with a 40 s ceiling, on every push that missed the trust cache. Measured on the
// v1.6.2 tree with a stand-in codex in an isolated profile: a cold push blocked
// the host 1,106 ms, a push after a config.toml touch 980 ms, and a push against a
// codex that never answers 31,331 ms. Every extension in the window froze for
// that long, and deactivate could not kill a spawnSync child. "Why did this
// prompt?" reached the same call.
//
// What these pin: the push reads the cached verdict only and never calls
// spawnSync; a miss posts the user-scope count marked pending, starts ONE
// off-thread refresh, and that refresh's own push brings the project rules in; a
// `.codex` with no `rules` folder starts nothing; a codex that never answers
// costs the push nothing and is killed, with everything under it, by deactivate;
// and the version probe a push started pushes once when it lands.
//
// Harness copied, not shared, per the suite's standing decision
// (test/extension-activation.test.js:509#sharing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');
const { performance } = require('node:perf_hooks');

const realSetTimeout = global.setTimeout;
const tick = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
// Longer than DASHBOARD_BOUNCE_MS (60 ms): refresh() is debounced.
const settle = () => tick(150);
// `what` may be a function, read only on a timeout, so the message says what was there instead.
async function until(predicate, ms = 8000, what = 'condition') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${typeof what === 'function' ? what() : what}`);
    await tick(25);
  }
}

function disposable() { return { dispose() {} }; }

// A temp home with one user-scope Codex rule, a workspace that is its own
// repository root (so no folder above it on the machine running the suite can
// become a candidate), and, unless `projectRules` is false, one project rule.
function fixture(t, { projectRules = true, codexConfigOnly = false } = {}) {
  const base = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-dash-trust-')));
  t.after(() => { try { fs.rmSync(base, { recursive: true, force: true }); } catch {} });
  const home = path.join(base, 'home');
  const codexHome = path.join(home, '.codex');
  const workspace = path.join(base, 'ws');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [], deny: [] } }));
  fs.mkdirSync(path.join(codexHome, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'rules', 'user.rules'), 'prefix_rule(pattern=["rg"], decision="allow")\n');
  fs.mkdirSync(path.join(workspace, '.git'), { recursive: true });
  fs.writeFileSync(path.join(workspace, '.git', 'HEAD'), 'ref: refs/heads/main\n');
  const projectFile = path.join(workspace, '.codex', 'rules', 'project.rules');
  if (projectRules) {
    fs.mkdirSync(path.dirname(projectFile), { recursive: true });
    fs.writeFileSync(projectFile, 'prefix_rule(pattern=["fd"], decision="allow")\n');
  }
  if (codexConfigOnly) {
    fs.mkdirSync(path.join(workspace, '.codex', 'hooks'), { recursive: true });
    fs.writeFileSync(path.join(workspace, '.codex', 'config.toml'), 'model = "x"\n');
  }
  return { base, home, codexHome, workspace, projectFile };
}

// A stand-in codex, reachable by path, run by node. `mode`:
//   answer -- --version, execpolicy check and app-server config/read all answer
//   hang   -- app-server writes its pid to `pidFile` and never answers anything
// `markFile`, when given, gets one line per invocation: proof it was run at all.
// `versionGate`, when given, holds `--version` until that file exists (20 s at
// most), so a test decides when the version probe lands instead of racing it.
// `layersGate` does the same for the app-server's config/read answer.
function fakeCodex(dir, mode, pidFile, markFile, versionGate, layersGate) {
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, 'fake-codex.js');
  fs.writeFileSync(script, `
const args = process.argv.slice(2);
if (${JSON.stringify(markFile || '')}) require('fs').appendFileSync(${JSON.stringify(markFile || '')}, args.join(' ') + '\\n');
if (args[0] === '--version') {
  const gate = ${JSON.stringify(versionGate || '')};
  const answer = () => { process.stdout.write('codex-cli 0.161.0\\n'); process.exit(0); };
  if (!gate) answer();
  const started = Date.now();
  setInterval(() => { if (require('fs').existsSync(gate) || Date.now() - started > 20000) answer(); }, 20);
} else if (args[0] === 'execpolicy') { process.stdout.write(JSON.stringify({ decision: 'allow', matchedRules: [] }) + '\\n'); process.exit(0); }
else if (${JSON.stringify(mode)} === 'hang') {
  require('fs').writeFileSync(${JSON.stringify(pidFile || '')}, String(process.pid));
  setInterval(() => {}, 1000);
} else {
  const rl = require('readline').createInterface({ input: process.stdin });
  rl.on('line', (line) => {
    const message = JSON.parse(line);
    if (message.id == null) return;
    const result = message.method === 'config/read'
      ? { config: {}, layers: [{ name: { type: 'project', dotCodexFolder: require('path').join(message.params.cwd, '.codex') }, version: 'x' }] }
      : {};
    const send = () => process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
    const gate = ${JSON.stringify(layersGate || '')};
    if (!gate || message.method !== 'config/read') { send(); return; }
    const started = Date.now();
    const wait = setInterval(() => {
      if (require('fs').existsSync(gate) || Date.now() - started > 20000) { clearInterval(wait); send(); }
    }, 20);
  });
  rl.on('close', () => process.exit(0));
}
`);
  if (process.platform === 'win32') {
    // The npm shape: a .cmd shim, so the launch is cmd.exe -> node.
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return shim;
  }
  const shim = path.join(dir, 'codex');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return shim;
}

// A stand-in for the asynchronous trust read, answered by the test. Everything
// else in src/codex-mcp-config.js is the real module.
function deferredLayers() {
  const stub = (options) => {
    stub.calls.push(options);
    return new Promise((resolve, reject) => {
      stub.pending.push({
        answer: () => resolve({ config: {}, layers: [{ name: { type: 'project',
          dotCodexFolder: path.join(options.workspaceRoot, '.codex') }, version: 'x' }] }),
        fail: reject,
      });
    });
  };
  stub.calls = [];
  stub.pending = [];
  return stub;
}

function harness(box, opts = {}) {
  const commands = new Map();
  const shown = [];
  const picks = [...(opts.picks || [])];
  const spawnSyncCalls = [];
  let provider = null;
  const codexExecutable = opts.codexExecutable || path.join(box.base, 'no-such-codex', 'codex');
  // What VS Code would hold for the key, tier by tier. Default: the user tier only.
  // `get` answers the way VS Code merges a window-scoped key, workspace first, which
  // is exactly the value a machine-scoped read must refuse to use.
  const tiers = opts.executableTiers || { globalValue: codexExecutable };
  const vscode = {
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class RelativePattern { constructor(b, p) { this.base = b; this.pattern = p; } },
    StatusBarAlignment: { Right: 2 },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    ProgressLocation: { Notification: 15 },
    Uri: { file: (fsPath) => ({ fsPath }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand() {},
    },
    window: {
      createStatusBarItem() { return { hide() {}, show() {}, dispose() {} }; },
      createOutputChannel() { return { appendLine() {}, append() {}, clear() {}, show() {}, dispose() {} }; },
      registerWebviewViewProvider(_viewId, instance) { provider = instance; return disposable(); },
      setStatusBarMessage() {},
      showErrorMessage(message) { shown.push({ level: 'error', message }); return Promise.resolve(undefined); },
      showInformationMessage(message, options) { shown.push({ level: 'info', message, options }); return Promise.resolve(undefined); },
      showWarningMessage(message) { shown.push({ level: 'warning', message }); return Promise.resolve(undefined); },
      showQuickPick(items) {
        const want = picks.shift();
        return Promise.resolve(Array.isArray(items) ? items.find((item) => item === want || item?.value === want) : undefined);
      },
      showInputBox() { return Promise.resolve(opts.input); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: box.workspace } }],
      createFileSystemWatcher(pattern) { return { pattern, onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }; },
      getConfiguration() {
        return {
          // The executable answers on both doors, so the test reads the same
          // value whichever one the extension uses for it.
          get: (key, fallback) => (key === 'autoLearn.codexExecutable'
            ? tiers.workspaceFolderValue ?? tiers.workspaceValue ?? tiers.globalValue ?? fallback
            : key === 'autoLearn.enabled' ? false : fallback),
          inspect: (key) => (key === 'autoLearn.codexExecutable' ? { defaultValue: 'codex', ...tiers } : {}),
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };

  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const policyPath = path.join(rootSrc, 'codex-policy.js');
  const repo = path.resolve(__dirname, '..') + path.sep;
  const originalLoad = Module._load;
  const originalHomeEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: box.home, USERPROFILE: box.home, CODEX_HOME: box.codexHome });
  const realChildProcess = require('node:child_process');
  // EVERY spawnSync any project module makes is recorded. The push must make none.
  // So is every spawn and execFile made on THIS thread (2026-10-14): on Windows each
  // one holds the calling thread for the length of CreateProcess. A worker thread's
  // modules load outside this hook, so what they start is not counted, by design.
  const hostSpawns = [];
  const spiedChildProcess = {
    ...realChildProcess,
    spawnSync(file, args, options) {
      spawnSyncCalls.push({ file, args, stack: new Error().stack });
      return realChildProcess.spawnSync(file, args, options);
    },
    spawn(file, ...rest) {
      hostSpawns.push({ file, via: 'spawn', stack: new Error().stack });
      return realChildProcess.spawn(file, ...rest);
    },
    execFile(file, ...rest) {
      hostSpawns.push({ file, via: 'execFile', stack: new Error().stack });
      return realChildProcess.execFile(file, ...rest);
    },
  };
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => box.home };
    if ((request === 'child_process' || request === 'node:child_process') && parent?.filename?.startsWith(repo)) {
      return spiedChildProcess;
    }
    if (opts.layers && request === './codex-mcp-config' && parent?.filename === policyPath) {
      const real = originalLoad.call(this, request, parent, isMain);
      return { ...real, readCodexConfigLayersAsync: opts.layers };
    }
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './codexMemoryGatesUi' && parent?.filename === extensionPath) {
      return { createCodexMemoryGatesUi: () => ({ activate() {}, dispose() {}, review() {}, status() { return {}; } }) };
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} onReconcile() { return disposable(); } },
        memoryReport: () => ({ conf: {}, dir: null, report: null, gateSources: undefined }),
        memoryStoreDir: () => null,
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const purge = () => {
    const extensionDir = path.dirname(extensionPath) + path.sep;
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(extensionDir)) delete require.cache[key];
    }
  };
  purge();
  // The extension's own timers are unref'd so a 5-minute interval cannot hold the
  // run open; the test's waits use realSetTimeout above.
  const originalSetTimeout = global.setTimeout;
  global.setTimeout = (fn, ms, ...rest) => {
    const handle = originalSetTimeout(fn, ms, ...rest);
    if (typeof handle?.unref === 'function') handle.unref();
    return handle;
  };
  const extension = require(extensionPath);
  extension.activate({ subscriptions: [] });

  const posted = [];
  const pushes = [];
  const view = {
    visible: true,
    webview: {
      options: null, html: null,
      onDidReceiveMessage() { return disposable(); },
      postMessage(payload) { posted.push(payload); return Promise.resolve(true); },
    },
    onDidDispose() { return disposable(); },
    onDidChangeVisibility() { return disposable(); },
  };
  let disposed = false;
  return {
    commands, shown, posted, pushes, spawnSyncCalls, hostSpawns, extension,
    get provider() { return provider; },
    // Times every push on the host thread and counts the spawnSync calls inside it.
    open() {
      const push = provider._push.bind(provider);
      provider._push = () => {
        const before = spawnSyncCalls.length;
        const start = performance.now();
        push();
        pushes.push({ ms: performance.now() - start, spawnSync: spawnSyncCalls.length - before });
      };
      provider.resolveWebviewView(view);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      try { await extension.deactivate(); } finally {
        global.setTimeout = originalSetTimeout;
        Module._load = originalLoad;
        for (const [key, value] of Object.entries(originalHomeEnv)) {
          if (value === undefined) delete process.env[key];
          else process.env[key] = value;
        }
        purge();
      }
    },
  };
}

// The real panel script, run against a minimal DOM, for what the counts READ as.
function render(html, data) {
  const open = html.match(/<script\b[^>]*>/);
  const start = open.index + open[0].length;
  const script = html.slice(start, html.indexOf('</script>', start));
  const nodes = new Map();
  const node = (id) => {
    if (!nodes.has(id)) {
      nodes.set(id, { id, textContent: '', className: '', title: '', disabled: false, innerHTML: '', style: {},
        hidden: false, value: '', dataset: {}, children: [],
        classList: { add() {}, remove() {}, toggle() {}, contains: () => false },
        addEventListener() {}, appendChild(child) { this.children.push(child); return child; }, removeChild() {},
        querySelector: () => null, querySelectorAll: () => [] });
    }
    return nodes.get(id);
  };
  const document = {
    getElementById: node, querySelectorAll: () => [], addEventListener() {},
    createElement: (tag) => ({ tag, className: '', textContent: '', innerHTML: '', title: '', style: {}, dataset: {},
      children: [], addEventListener() {}, appendChild(child) { this.children.push(child); return child; } }),
    createTextNode: (text) => ({ textContent: text }),
  };
  // eslint-disable-next-line no-new-func
  const api = new Function('document', 'window', 'acquireVsCodeApi', 'console', `${script}\nreturn { render };`)(
    document, { addEventListener() {} }, () => ({ postMessage() {}, getState() {}, setState() {} }), console);
  api.render(data);
  return Object.assign((id) => node(id).textContent, { items: (id) => node(id).children.map((child) => child.textContent) });
}

const codexLabels = (data) => data.savedPermissions.filter((entry) => entry.agent === 'codex').map((entry) => entry.label);

test('a cold push never spawns synchronously, refreshes trust once off-thread, and the refresh pushes the project rules in', async (t) => {
  const box = fixture(t);
  const layers = deferredLayers();
  const app = harness(box, { layers });
  try {
    app.open();
    await settle();
    assert.ok(app.pushes.length >= 1, 'precondition: the panel pushed');
    // MUTATION: drop `projectTrust: 'cached'` from the push's summary read. The
    // push asks Codex through spawnSync and this counts 1 (and the push blocks for
    // as long as the worker runs). Confirmed 2026-10-14.
    assert.deepEqual(app.pushes.map((push) => push.spawnSync), app.pushes.map(() => 0),
      'the push called spawnSync on the extension host thread');
    const cold = app.posted.at(-1);
    assert.equal(cold.codexPermissions.pending, true, 'the cold push says the project rules are not counted yet');
    assert.deepEqual(codexLabels(cold), ['["rg"]'], 'user scope only, never a guessed project rule');
    const coldText = render(app.provider._html(), cold);
    assert.equal(coldText('codexTotal'), '1+', 'a pending count reads as a lower bound');
    assert.match(coldText('permissionCoverage'), /Checking which project rule folders Codex trusts/);
    assert.equal(layers.calls.length, 1, 'one refresh was started off-thread');

    // A burst while Codex is still being asked starts nothing more.
    for (let index = 0; index < 4; index += 1) app.provider.refresh();
    await settle();
    assert.equal(layers.calls.length, 1, 'pushes while a refresh is in flight do not start another');
    const before = app.posted.length;

    layers.pending[0].answer();
    // No refresh() call from the test: the refresh's own push is the observable.
    // MUTATION: drop `if (landed) dashboard?.refresh()` from the refresh. Nothing
    // pushes and this times out. Confirmed 2026-10-14.
    await until(() => app.posted.length > before, 3000, 'the push the settled refresh asks for');
    const warm = app.posted.at(-1);
    assert.equal(warm.codexPermissions.pending, false);
    assert.deepEqual(codexLabels(warm).sort(), ['["fd"]', '["rg"]'], 'the trusted project rule is counted now');
    assert.equal(render(app.provider._html(), warm)('codexTotal'), '2');

    // Fresh now: further pushes neither ask nor spawn.
    app.provider.refresh();
    await settle();
    assert.equal(layers.calls.length, 1);
    assert.ok(app.pushes.every((push) => push.spawnSync === 0));
  } finally {
    await app.dispose();
  }
});

// THE PUSH STARTS NO PROCESS ON THE HOST THREAD (2026-10-14). On Windows a spawn
// holds the calling thread for the length of CreateProcess, and on the development
// box that is 200-470 ms for node and the real codex.exe: a cold push held the
// extension host for 673 ms (p50, n=11) on the tree before this change, all of it
// in the version probe's execFile and the trust worker's spawn. Both now run on
// worker threads (src/spawn-thread.js). The real worker and a stand-in codex that
// answers both questions, so the answers that arrive prove the threads did the work.
test('a cold push starts no process on the host thread, and both Codex answers still arrive', async (t) => {
  const box = fixture(t);
  const marks = path.join(box.base, 'ran.log');
  const codex = fakeCodex(path.join(box.base, 'bin'), 'answer', null, marks);
  const app = harness(box, { codexExecutable: codex });
  try {
    app.open();
    await until(() => app.posted.some((data) => data.codexMemory?.cli?.version)
      && app.posted.at(-1)?.codexPermissions?.pending === false, 30000,
    () => `the version and the trust verdict; the last push had ${JSON.stringify({ cli: app.posted.at(-1)?.codexMemory?.cli?.reason
      ?? app.posted.at(-1)?.codexMemory?.cli?.version ?? null, pending: app.posted.at(-1)?.codexPermissions?.pending })}`);
    const ran = fs.readFileSync(marks, 'utf8');
    assert.match(ran, /^--version$/m, 'precondition: the version probe ran the stand-in');
    assert.match(ran, /^app-server --stdio$/m, 'precondition: the trust worker ran the stand-in');
    assert.equal(app.posted.at(-1).codexMemory.cli.version, '0.161.0');
    assert.deepEqual(codexLabels(app.posted.at(-1)).sort(), ['["fd"]', '["rg"]'], 'the trust answer was read');
    // MUTATION: drop `offThread: true` from the push's dashboardCodexVersion call.
    // The probe's execFile runs here and is listed. The same for the one in
    // refreshProjectTrustForDashboard: the worker's spawn is listed. Confirmed 2026-10-14.
    assert.deepEqual(app.hostSpawns.map((entry) => `${entry.via} ${path.basename(String(entry.file))}`), [],
      'a process was started on the extension host thread');
  } finally {
    await app.dispose();
  }
});

// THE VERSION DOES NOT WAIT FOR THE TRUST ASK THE SAME PUSH STARTED (2026-10-20). The test
// above timed out at 30 s in one of three loaded full runs, and the timing capture showed
// why: the two threads a cold push starts spawned at the same moment, the config worker
// inherited the version probe's stdout, so the probe's 'close' waited for the worker to exit,
// and its 5 s timer called it "timed out" first (src/spawn-thread.js, "ONE SPAWN AT A TIME").
// Here that wait is made unconditional, without a clock: the stand-in holds its config/read
// answer until this test writes `gate`, and the test writes it only once the version is on
// screen. So the version can land only if it never depended on the trust worker.
test('the version a cold push asks for lands while the trust ask it started is still open', async (t) => {
  const box = fixture(t);
  const gate = path.join(box.base, 'layers-gate');
  const codex = fakeCodex(path.join(box.base, 'bin'), 'answer', null, null, null, gate);
  const app = harness(box, { codexExecutable: codex });
  try {
    app.open();
    const cli = () => app.posted.findLast((data) => data.codexMemory?.cli)?.codexMemory.cli;
    // MUTATION: run spawn-thread's two spawns ungated (`gated` returns start() at once). The
    // worker holds the probe's pipe, so the probe's answer cannot come before the worker exits,
    // which is after this test opens the gate: this times out. Confirmed 2026-10-20, 5 of 5.
    await until(() => cli()?.version || cli()?.reason, 15000,
      () => `the version probe to answer, with the trust ask still open (the last push had cli ${JSON.stringify(cli() ?? null)})`);
    assert.equal(cli().version, '0.161.0', `the version probe answered ${JSON.stringify(cli())}`);
    assert.equal(app.posted.at(-1).codexPermissions.pending, true,
      'precondition: the trust ask was still waiting on the gate when the version landed');
    fs.writeFileSync(gate, '');
    await until(() => app.posted.at(-1)?.codexPermissions?.pending === false, 30000, 'the trust verdict');
    assert.deepEqual(codexLabels(app.posted.at(-1)).sort(), ['["fd"]', '["rg"]'], 'the trust answer was read');
  } finally {
    try { fs.writeFileSync(gate, ''); } catch {}
    await app.dispose();
  }
});

test('a .codex folder with no rules folder starts no refresh, and nothing is pending', async (t) => {
  const box = fixture(t, { projectRules: false, codexConfigOnly: true });
  const layers = deferredLayers();
  const app = harness(box, { layers });
  try {
    app.open();
    await settle();
    const data = app.posted.at(-1);
    // MUTATION: test `directoryExists(folder)` instead of `<folder>/rules` in
    // projectCandidates. This push goes pending and asks once. Confirmed 2026-10-14.
    assert.equal(data.codexPermissions.pending, false);
    assert.equal(layers.calls.length, 0, 'config.toml and hooks alone are no reason to ask Codex');
    assert.equal(render(app.provider._html(), data)('codexTotal'), '1');
  } finally {
    await app.dispose();
  }
});

// F4 of the v1.6.3 confirmation audit (2026-10-14). The Saved permissions card said "No saved
// permissions yet" while the trust verdict was pending and the only rules were a project's: the
// push lists user scope alone until Codex has said which project folders it trusts, and the
// card's empty test read `codexPermissions.complete`, which a pending check leaves true. The
// counts above it already read the pending flag (codexCounted); the list now does too.
test('a pending trust verdict over project-only Codex rules renders as pending, not as no saved permissions', async (t) => {
  const box = fixture(t);
  fs.rmSync(path.join(box.codexHome, 'rules', 'user.rules'));
  const layers = deferredLayers();
  const app = harness(box, { layers });
  try {
    app.open();
    await settle();
    const cold = app.posted.at(-1);
    assert.equal(cold.codexPermissions.pending, true, 'precondition: the verdict is pending');
    assert.equal(cold.codexPermissions.complete, true, 'precondition: a pending check is not a failed read');
    assert.deepEqual(cold.savedPermissions, [], 'precondition: nothing is listed yet, the project rule exists');
    const coldView = render(app.provider._html(), cold);
    // MUTATION: drop `&& codexCounted(codex)` from the empty-list test in the panel's render.
    // The card says "No saved permissions yet" over a project rule and this fails.
    // Confirmed 2026-10-14.
    assert.ok(!coldView.items('list').some((text) => /No saved permissions yet/.test(text)),
      `a pending verdict rendered as empty: ${JSON.stringify(coldView.items('list'))}`);
    // MUTATION: drop `|| !codexCounted(codex)` from the test for the list's closing note. The
    // list is silent about why it is empty and this fails. Confirmed 2026-10-14.
    assert.deepEqual(coldView.items('list'),
      ['Codex project rules not listed yet: checking which project rule folders Codex trusts.']);
    assert.equal(coldView('codexTotal'), '?', 'and the count says it does not know yet');

    // The control: the verdict settles, the project rule is listed, and nothing says pending.
    const before = app.posted.length;
    layers.pending[0].answer();
    await until(() => app.posted.length > before, 3000, 'the push the settled refresh asks for');
    const warm = app.posted.at(-1);
    assert.equal(warm.codexPermissions.pending, false);
    const warmView = render(app.provider._html(), warm);
    assert.deepEqual(warmView.items('list').filter((text) => /No saved permissions yet|not listed yet/.test(text)), []);
    assert.deepEqual(codexLabels(warm), ['["fd"]']);
    assert.equal(warmView('codexTotal'), '1');
  } finally {
    await app.dispose();
  }
});

// The other control: with no rules anywhere and nothing to ask about, the card still says empty.
test('with no rules anywhere and no verdict pending, the card still says no saved permissions', async (t) => {
  const box = fixture(t, { projectRules: false });
  fs.rmSync(path.join(box.codexHome, 'rules', 'user.rules'));
  const layers = deferredLayers();
  const app = harness(box, { layers });
  try {
    app.open();
    await settle();
    const data = app.posted.at(-1);
    assert.equal(data.codexPermissions.pending, false, 'precondition: nothing to ask about');
    assert.deepEqual(render(app.provider._html(), data).items('list'),
      ['No saved permissions yet: approve some commands, or click Optimize permissions.']);
  } finally {
    await app.dispose();
  }
});

test('a codex that never answers costs the push nothing, and deactivate ends it with everything under it', async (t) => {
  const box = fixture(t);
  const pidFile = path.join(box.base, 'hung-codex.pid');
  const codex = fakeCodex(path.join(box.base, 'bin'), 'hang', pidFile);
  const app = harness(box, { codexExecutable: codex });
  let pid = null;
  try {
    app.open();
    await settle();
    // Before 2026-10-14 this push was a spawnSync bounded at 40 s: 31,331 ms measured.
    assert.ok(app.pushes[0].ms < 2000, `the push blocked the host for ${Math.round(app.pushes[0].ms)} ms`);
    assert.equal(app.posted.at(-1).codexPermissions.pending, true);
    // The real worker really did start the stand-in, which is now hanging.
    await until(() => fs.existsSync(pidFile) && fs.readFileSync(pidFile, 'utf8').trim(), 10000, 'the hung codex to start');
    pid = Number(fs.readFileSync(pidFile, 'utf8').trim());
    assert.doesNotThrow(() => process.kill(pid, 0), 'precondition: the stand-in codex is running');

    await app.dispose();
    // MUTATION: make killLiveChildren call child.kill() alone again. On Windows the
    // stand-in (worker -> cmd.exe -> node) outlives the extension and this times
    // out. Confirmed 2026-10-14.
    // On POSIX the same kill is a group signal, and it reaches the stand-in only
    // because the worker leads its own group. MUTATION: spawn the worker with
    // `detached: false` in nativeRpcAsync (src/codex-mcp-config.js), which is what
    // execFile made of `detached: true` until 2026-10-14. This times out on Linux,
    // as it did on every Ubuntu leg of CI run 38525363435. Confirmed 2026-10-14.
    await until(() => { try { process.kill(pid, 0); return false; } catch { return true; } }, 5000,
      'the hung codex to be killed with the worker that started it');
    pid = null;
  } finally {
    await app.dispose();
    if (pid) { try { process.kill(pid); } catch {} }
  }
});

test('"Why did this prompt?" awaits the off-thread trust answer and then names the project rule', async (t) => {
  const box = fixture(t);
  const codex = fakeCodex(path.join(box.base, 'bin'), 'answer');
  const layers = deferredLayers();
  const app = harness(box, { layers, codexExecutable: codex, picks: ['codex', 'Bash'], input: 'fd --version' });
  try {
    const before = app.spawnSyncCalls.length;
    const explained = app.commands.get('permission-wildcarding.autoLearnWhy')();
    await until(() => layers.calls.length === 1, 3000, 'the trust refresh to be asked');
    // MUTATION: make codexRuleFileSetFor synchronous again (codexRuleFileSet with no
    // projectTrust). The sync ask spawnSyncs the worker on the host instead of
    // asking off-thread, so the wait above times out. Confirmed 2026-10-14.
    assert.equal(app.spawnSyncCalls.length - before, 0, 'the explanation blocked the host on spawnSync');
    assert.equal(app.shown.filter((entry) => entry.message === 'Codex execpolicy analysis').length, 0,
      'nothing is reported before Codex has said which project folders it trusts');
    layers.pending[0].answer();
    await explained;
    const analysis = app.shown.find((entry) => entry.message === 'Codex execpolicy analysis');
    assert.ok(analysis, `the analysis was shown: ${JSON.stringify(app.shown.map((entry) => entry.message))}`);
    assert.match(analysis.options.detail, /project\.rules/, 'the trusted project rule was checked with the rest');
  } finally {
    await app.dispose();
  }
});

test('the Codex version probe a push started pushes once when it lands, and then stops', async (t) => {
  const box = fixture(t, { projectRules: false });
  // THE TEST DECIDES WHEN THE PROBE LANDS (2026-10-14). The precondition below
  // assumed the stand-in's --version took longer than the 150 ms settle. On
  // Windows it does (cmd.exe -> node); on Linux (sh exec node) it answered inside
  // it on all three Ubuntu legs of CI run 38525363435, the probe's own push had
  // already happened, and the precondition read the version. Run alone the file
  // passed there too, because the first spawn was slower. Gated, the probe cannot
  // land until the precondition has been checked.
  const gate = path.join(box.base, 'version-gate');
  const codex = fakeCodex(path.join(box.base, 'bin'), 'answer', null, null, gate);
  const app = harness(box, { codexExecutable: codex });
  try {
    app.open();
    await settle();
    // MUTATION: drop the `versionGate` argument above. On Linux the stand-in
    // answers inside the settle and this fails as it did in CI. Confirmed 2026-10-14.
    assert.equal(app.posted.at(-1).codexMemory.cli, null, 'precondition: nothing cached yet, so the line is blank');
    const before = app.posted.length;
    fs.writeFileSync(gate, '');
    // MUTATION: drop `onSettled` from the push's dashboardCodexVersion call. The
    // line stays blank until an unrelated push and this times out. Confirmed 2026-10-14.
    await until(() => app.posted.length > before, 10000, 'the push the settled probe asks for');
    assert.equal(app.posted.at(-1).codexMemory.cli.version, '0.161.0');
    const after = app.posted.length;
    await tick(600);
    assert.equal(app.posted.length, after, 'one push for one probe: the cached answer starts nothing');
  } finally {
    await app.dispose();
  }
});

// FINDING 2 (2026-10-14): `autoLearn.codexExecutable` names a program the extension
// runs unprompted (this file's pushes run its --version and its app-server). It was
// window-scoped, so a repository's .vscode/settings.json could aim it at a binary
// the repository ships. The extension is disabled in Restricted Mode (no
// untrustedWorkspaces capability is declared, which VS Code treats as "not
// supporting Workspace Trust"), but a trusted folder is not a vetted binary.
test('the manifest declares the Codex executable machine-scoped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'package.json'), 'utf8'));
  const setting = manifest.contributes?.configuration?.properties?.['permissionWildcarding.autoLearn.codexExecutable'];
  assert.ok(setting, 'precondition: the key is declared');
  // MUTATION: drop `"scope": "machine"`. This fails. Confirmed 2026-10-14.
  assert.equal(setting.scope, 'machine', 'any wider scope lets a workspace settings file choose the binary');
  assert.equal(manifest.capabilities?.untrustedWorkspaces, undefined,
    'precondition for the README\'s Restricted Mode claim: no capability is declared, so VS Code disables the extension there');
});

test('a workspace-level Codex executable is never run, and a user-level one is', async (t) => {
  // The hostile shape: a binary inside the repository, named by the repository's
  // own settings file. The dashboard push would run its --version unprompted.
  const hostile = fixture(t, { projectRules: false });
  const marks = path.join(hostile.base, 'ran.log');
  const repoBinary = fakeCodex(path.join(hostile.workspace, 'tools'), 'answer', null, marks);
  const app = harness(hostile, { executableTiers: { workspaceValue: repoBinary } });
  try {
    app.open();
    await settle();
    await tick(1500);
    // MUTATION: read the key with cfg.get() again. The push probes the repository's
    // binary and the mark file appears. Confirmed 2026-10-14.
    assert.equal(fs.existsSync(marks), false, 'the repository-named binary was run');
    const cli = app.posted.at(-1).codexMemory.cli;
    assert.ok(cli === null || cli.executable === 'codex',
      `the push asked about ${cli && cli.executable}, not the default`);
  } finally {
    await app.dispose();
  }

  // The control: the same binary set in USER settings is honoured.
  const trusted = fixture(t, { projectRules: false });
  const userMarks = path.join(trusted.base, 'ran.log');
  const userBinary = fakeCodex(path.join(trusted.base, 'bin'), 'answer', null, userMarks);
  const control = harness(trusted, { executableTiers: { globalValue: userBinary } });
  try {
    control.open();
    await until(() => fs.existsSync(userMarks), 10000, 'the user-level binary to be probed');
    assert.match(fs.readFileSync(userMarks, 'utf8'), /--version/);
  } finally {
    await control.dispose();
  }
});

// "WHY DID THIS PROMPT?" NEVER RUNS A CODEX FROM THE HOST'S CWD (2026-10-14). Its
// execpolicy check handed execFile whatever commandLaunch returned, and for a name that
// PATH does not hold that is the bare name, which libuv looks for in the current
// directory first unless the extension host's own environment carries
// NoDefaultCurrentDirectoryInExePath. The host's cwd is wherever VS Code was started. Here
// it holds a copy of node named like the configured executable, a --require preload
// writes a flag only when it runs as that copy, and the variable is removed from this
// process for the call: an agent shell often sets it, and with it set the unfixed code
// passes too.
test('"Why did this prompt?" refuses a codex name PATH does not hold, and never runs the copy in the host\'s cwd', { skip: process.platform !== 'win32' }, async (t) => {
  const box = fixture(t);
  const name = 'acolyte-planted-codex';
  const cwd = path.join(box.base, 'host-cwd');
  fs.mkdirSync(cwd);
  fs.copyFileSync(process.execPath, path.join(cwd, `${name}.exe`));
  const flag = path.join(box.base, 'planted-codex-ran');
  const marker = path.join(box.base, 'planted-marker.js');
  fs.writeFileSync(marker, `if (/acolyte-planted-codex\\.exe$/i.test(process.execPath)) require('fs').writeFileSync(${JSON.stringify(flag)}, process.argv.slice(1).join(' '));\n`);
  const layers = deferredLayers();
  const app = harness(box, { layers, codexExecutable: name, picks: ['codex', 'Bash'], input: 'fd --version' });
  const saved = { cwd: process.cwd(), noCwd: process.env.NoDefaultCurrentDirectoryInExePath, nodeOptions: process.env.NODE_OPTIONS };
  try {
    delete process.env.NoDefaultCurrentDirectoryInExePath;
    // NODE_OPTIONS reads a backslash inside quotes as an escape: forward slashes.
    process.env.NODE_OPTIONS = `--require "${marker.split(path.sep).join('/')}"`;
    process.chdir(cwd);
    const explained = app.commands.get('permission-wildcarding.autoLearnWhy')();
    await until(() => layers.calls.length === 1, 3000, 'the trust refresh to be asked');
    layers.pending[0].answer();
    await explained;
  } finally {
    process.chdir(saved.cwd);
    for (const [key, value] of [['NoDefaultCurrentDirectoryInExePath', saved.noCwd], ['NODE_OPTIONS', saved.nodeOptions]]) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    await app.dispose();
  }
  // MUTATION: launch execFileCaptured's check from commandLaunch again. execFile gets the
  // bare name, the copy in the cwd runs (writing the flag once it is past the scan), and
  // the check fails as that copy's error instead. Confirmed 2026-10-14.
  assert.equal(fs.existsSync(flag), false, `the codex in the host's cwd ran: ${fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8') : ''}`);
  const failed = app.shown.filter((entry) => entry.level === 'error').map((entry) => entry.message);
  assert.deepEqual(failed, [`Codex execpolicy check failed without changing rules: spawn ${name} ENOENT`],
    'the failure reads as spawn\'s own ENOENT, as it did before');
});

// "WHY DID THIS PROMPT?" NEVER HANDS PASTED TEXT TO cmd.exe (2026-10-14, S1 of the final
// pre-tag audit, the BatBadBut class). The audit's input, end to end: Codex, Bash, and a
// quoted token carrying %CMDCMDLINE:~-1%, which cmd.exe expands to the quote that closes
// its own command line, so the `&echo injected>F` after it ran while the user saw an
// ordinary analysis. F is relative, so it lands in the host's cwd, which is a folder of
// the test's own for the call.
const INJECTED_TOKEN = '--x%CMDCMDLINE:~-1%&echo injected>F&rem ';
async function explainInHostCwd(app, layers, cwd) {
  fs.mkdirSync(cwd, { recursive: true });
  const saved = process.cwd();
  process.chdir(cwd);
  try {
    const explained = app.commands.get('permission-wildcarding.autoLearnWhy')();
    await until(() => layers.calls.length === 1, 3000, 'the trust refresh to be asked');
    layers.pending[0].answer();
    await explained;
  } finally {
    process.chdir(saved);
  }
}

test('"Why did this prompt?" refuses a pasted %CMDCMDLINE:~-1% token for a batch-file codex, and the injected command never runs', { skip: process.platform !== 'win32' }, async (t) => {
  const box = fixture(t);
  const marks = path.join(box.base, 'ran.log');
  // fakeCodex's two-line .cmd is not npm's shape, so only cmd.exe can run it.
  const codex = fakeCodex(path.join(box.base, 'bin'), 'answer', null, marks);
  const layers = deferredLayers();
  const app = harness(box, { layers, codexExecutable: codex, picks: ['codex', 'Bash'], input: `fd '${INJECTED_TOKEN}'` });
  const cwd = path.join(box.base, 'host-cwd');
  try {
    await explainInHostCwd(app, layers, cwd);
  } finally {
    await app.dispose();
  }
  // MUTATION: drop the batchArgumentRefusal check from commandLaunch (src/exec-resolve.js).
  // The check runs through cmd.exe, F is created, and the stand-in answers. Confirmed 2026-10-14.
  assert.equal(fs.existsSync(path.join(cwd, 'F')), false, 'the injected command ran');
  assert.equal(fs.existsSync(marks) && /execpolicy/.test(fs.readFileSync(marks, 'utf8')), false, 'the check was run at all');
  assert.equal(app.shown.filter((entry) => entry.message === 'Codex execpolicy analysis').length, 0);
  const failed = app.shown.filter((entry) => entry.level === 'error').map((entry) => entry.message);
  assert.equal(failed.length, 1, JSON.stringify(failed));
  assert.match(failed[0], /^Codex execpolicy check failed without changing rules: Refused to run codex\.cmd: argument \d+ contains "%"\. .* Nothing was run\. A codex\.exe, or the codex\.cmd npm installs, receives any argument: point permissionWildcarding\.autoLearn\.codexExecutable at one\.$/);
});

test('"Why did this prompt?" runs the codex.cmd npm writes as its node script, so the same token arrives verbatim and runs nothing', { skip: process.platform !== 'win32' }, async (t) => {
  let cmdShim;
  try { cmdShim = require(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'cmd-shim')); }
  catch { t.skip('npm\'s bundled cmd-shim is not next to this node'); return; }
  const box = fixture(t);
  const marks = path.join(box.base, 'ran.jsonl');
  const npm = path.join(box.base, 'npm');
  const bin = path.join(npm, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  // The shebang is what makes cmd-shim write its node form, as npm's own codex.js has one.
  fs.writeFileSync(path.join(bin, 'codex.js'), [
    '#!/usr/bin/env node',
    `require('fs').appendFileSync(${JSON.stringify(marks)}, JSON.stringify(process.argv.slice(2)) + '\\n');`,
    'process.stdout.write(JSON.stringify({ decision: \'allow\', matchedRules: [] }) + \'\\n\');',
    '',
  ].join('\n'));
  await cmdShim(path.join(bin, 'codex.js'), path.join(npm, 'codex'));
  const layers = deferredLayers();
  const app = harness(box, { layers, codexExecutable: path.join(npm, 'codex.cmd'), picks: ['codex', 'Bash'],
    input: `fd '${INJECTED_TOKEN}'` });
  const cwd = path.join(box.base, 'host-cwd');
  try {
    await explainInHostCwd(app, layers, cwd);
  } finally {
    await app.dispose();
  }
  assert.equal(fs.existsSync(path.join(cwd, 'F')), false, 'the injected command ran');
  // MUTATION: launch execFileCaptured's check from resolvedLaunch alone again. The .cmd route
  // refuses the token, so no analysis is shown and nothing is recorded. Confirmed 2026-10-14.
  assert.ok(app.shown.some((entry) => entry.message === 'Codex execpolicy analysis'),
    `the analysis was not shown: ${JSON.stringify(app.shown.map((entry) => entry.message))}`);
  const runs = fs.readFileSync(marks, 'utf8').trim().split('\n').map((line) => JSON.parse(line));
  assert.equal(runs.length, 1, 'one variant, one check');
  assert.equal(runs[0].at(-2), 'fd');
  assert.match(runs[0].at(-1), /^--x%CMDCMDLINE:~-1%&echo injected>F&rem ?$/, 'the token did not arrive as written');
});
