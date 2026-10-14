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
// (test/extension-activation.test.js:311#sharing).

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
async function until(predicate, ms = 8000, what = 'condition') {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > ms) assert.fail(`timed out waiting for ${what}`);
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
function fakeCodex(dir, mode, pidFile, markFile, versionGate) {
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
    process.stdout.write(JSON.stringify({ id: message.id, result }) + '\\n');
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
  const spiedChildProcess = {
    ...realChildProcess,
    spawnSync(file, args, options) {
      spawnSyncCalls.push({ file, args, stack: new Error().stack });
      return realChildProcess.spawnSync(file, args, options);
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
    commands, shown, posted, pushes, spawnSyncCalls, extension,
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
  return (id) => node(id).textContent;
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
