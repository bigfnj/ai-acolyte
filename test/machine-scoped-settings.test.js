'use strict';

// TWO SETTINGS THAT NAME A FILE THE EXTENSION ACTS ON ARE READ FROM USER SETTINGS ONLY
// (2026-10-14, F7 of the v1.6.3 confirmation audit).
//
// `memory.recallScript` names a Python script the extension runs (the Codex memory rebuild
// and search hand it to the worker, the recall rebuild and the gate compiler spawn it), and
// `backupMirrorPath` names where it writes a copy of the user's allow and deny lists. Both
// were window-scoped, so a repository's .vscode/settings.json could choose either. They are
// `"scope": "machine"` now and read from inspect().globalValue alone, as
// autoLearn.codexExecutable is (vscode-extension/extension.js codexExecutableSetting; its own
// tests are in test/dashboard-project-trust.test.js). The mirror path's tier tests live with
// the backup tests (test/policy-backup.test.js); this file holds the manifest and the script.
//
// Harness copied, not shared, per the suite's standing decision
// (test/extension-activation.test.js:505#sharing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

test('the manifest declares the recall script and the backup mirror path machine-scoped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'package.json'), 'utf8'));
  const properties = manifest.contributes?.configuration?.properties || {};
  for (const key of ['permissionWildcarding.memory.recallScript', 'permissionWildcarding.backupMirrorPath']) {
    assert.ok(properties[key], `precondition: ${key} is declared`);
    // MUTATION: drop `"scope": "machine"` from either key. This fails. Confirmed 2026-10-14.
    assert.equal(properties[key].scope, 'machine', `${key}: any wider scope lets a workspace settings file choose it`);
  }
});

// What the worker is handed for a Codex memory rebuild, with `memory.recallScript` set at the
// tiers given. The worker is scripted, so nothing is run; the script it would run is the
// observable.
async function recallScriptHandedToWorker(t, tiers) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-machine-scope-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));
  const workspace = path.join(home, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  const calls = [];
  const disposable = () => ({ dispose() {} });
  const commands = new Map();
  const tier = (key) => (key === 'memory.recallScript' ? tiers : undefined);
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ThemeColor: class ThemeColor {}, Uri: { file: (p) => ({ fsPath: p }) },
    commands: { registerCommand(id, handler) { commands.set(id, handler); return disposable(); }, executeCommand() {} },
    window: {
      createOutputChannel() { return { appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }; },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); },
      withProgress(options, task) { return task({ report() {} }); },
      setStatusBarMessage() {}, showErrorMessage() {}, showWarningMessage() { return Promise.resolve(undefined); },
      showInformationMessage() { return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { fsPath: workspace } }],
      createFileSystemWatcher() { return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }; },
      getConfiguration() {
        return {
          // VS Code's merge: folder over workspace over user. The value a machine-scoped read refuses.
          get: (key, fallback) => {
            const value = tier(key);
            if (value) return value.workspaceFolderValue ?? value.workspaceValue ?? value.globalValue ?? fallback;
            return key === 'autoLearn.enabled' ? false : fallback;
          },
          inspect: (key) => tier(key) || {},
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); }, onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };
  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  const originalHomeEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') });
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
    if (parent?.filename === extensionPath && request === './autoLearnWorkerRunner') {
      return { createAutoLearnWorkerRunner: () => ({
        async run(operation, ...args) { calls.push({ operation, args }); return {}; },
        async deactivate() {},
      }) };
    }
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    if (request === './memoryLint' && parent?.filename === extensionPath) {
      return {
        MemoryLint: class MemoryLint { activate() {} onReconcile() { return disposable(); } },
        memoryReport: () => ({ conf: {}, dir: null, report: null }),
        cfg: () => ({ enabled: true, dir: '', lineBudget: 300, totalBudget: 12000, maxLines: 200 }),
        discoverDirs: () => [],
      };
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const purge = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(path.dirname(extensionPath) + path.sep)) delete require.cache[key];
    }
  };
  let extension;
  try {
    purge();
    extension = require(extensionPath);
    extension.activate({ subscriptions: [] });
    await commands.get('permission-wildcarding.rebuildCodexMemory')();
  } finally {
    try { await extension?.deactivate?.(); } catch { /* teardown only */ }
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalHomeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    purge();
  }
  const rebuild = calls.find((call) => call.operation === 'rebuildCodexMemory');
  assert.ok(rebuild, `precondition: the rebuild reached the worker: ${JSON.stringify(calls.map((call) => call.operation))}`);
  return rebuild.args[0]?.recallOptions?.recallScript;
}

test('a workspace-level recall script is never handed to the worker, and a user-level one is', async (t) => {
  // The hostile shape: a script inside the repository, named by the repository's own settings.
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-recall-scripts-'));
  t.after(() => fs.rmSync(base, { recursive: true, force: true }));
  const planted = path.join(base, 'repo-recall.py');
  const chosen = path.join(base, 'user-recall.py');
  for (const file of [planted, chosen]) fs.writeFileSync(file, '# fixture, never run\n');

  // MUTATION: read memory.recallScript with cfg.get() again in recallScriptPath. The worker is
  // handed the repository's script and this fails. Confirmed 2026-10-14.
  const fromWorkspace = await recallScriptHandedToWorker(t, { workspaceValue: planted });
  assert.notEqual(fromWorkspace, planted, 'a workspace settings file chose the script the extension runs');
  const fromFolder = await recallScriptHandedToWorker(t, { globalValue: chosen, workspaceFolderValue: planted });
  assert.equal(fromFolder, chosen, 'a folder value outranked the user value for a machine-scoped key');

  // The control: the user tier is honoured.
  assert.equal(await recallScriptHandedToWorker(t, { globalValue: chosen }), chosen);
});

// ── THREE SETTINGS THAT DECIDE WHAT THE USER'S GLOBAL INSTRUCTION FILES SAY (2026-10-14, S2 of
// the final pre-tag audit) ─────────────────────────────────────────────────────────────────
//
// `memory.dir` chose the corpus whose `scope: global` gate blocks become the user's standing
// orders in every project. memoryLint.js read it with get(), memoryReport() returned it, and
// compileGates handed it to `recall.py --gates-compile` as RECALL_MEMORY_DIR, unattended after
// any memory edit once the block was installed, and ensureGates installed the result into
// ~/.claude/CLAUDE.md (and ~/.codex/AGENTS.md). Reproduced first in a sandbox with a real
// python: a workspace-level value replaced the user's own gate with the repository's after one
// memory edit. `gates.enabled` and `guidance.enabled` decide whether those files carry each
// block at all, on activation. All three were window-scoped.
//
// A window over a temp home: the real memoryLint, a configuration that answers tier by tier as
// VS Code merges it, and the toolbox python RECORDED, never run. The corpus each compile was
// handed, and what activation left in CLAUDE.md, are the observables.
const { EventEmitter } = require('node:events');
const { GATES_BEGIN, makeGatesBlock } = require('../src/agent-gates');
const { BEGIN: GUIDANCE_BEGIN, applyGuidance } = require('../src/agent-guidance');

async function instructionWindow(t, tiers, prepare = () => {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-instruction-scope-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const claude = path.join(home, '.claude');
  const store = path.join(claude, 'projects', 'p', 'memory');
  const workspace = path.join(home, 'repo');
  const planted = path.join(workspace, '.mem');
  const elsewhere = path.join(home, 'my-other-memory');
  const gate = (rule) => `---\nname: g\ntype: feedback\nscope: global\n---\nrule\n<!-- gate -->\n- ${rule}\n<!-- /gate -->\n`;
  for (const [dir, rule] of [[store, 'USER RULE'], [planted, 'PLANTED RULE'], [elsewhere, 'OTHER USER RULE']]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'MEMORY.md'), '- [g](g.md) - hook\n');
    fs.writeFileSync(path.join(dir, 'g.md'), gate(rule));
  }
  fs.writeFileSync(path.join(claude, 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));
  const claudeMd = path.join(claude, 'CLAUDE.md');
  fs.writeFileSync(claudeMd, '# my own instructions\n');
  // recallStatus() asks only that the toolbox python exists. It is recorded below, never run.
  const python = path.join(home, 'toolbox', 'python', '.venv', 'Scripts', 'python.exe');
  fs.mkdirSync(path.dirname(python), { recursive: true });
  fs.writeFileSync(python, '');
  const box = { home, store, planted, elsewhere, claudeMd };
  prepare(box);
  // Tiers can name this window's own folders, so they may be given as a function of them.
  if (typeof tiers === 'function') tiers = tiers(box);

  const watchers = [];
  const compiles = [];
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
      createOutputChannel() { return { appendLine() {}, append() {}, show() {}, clear() {}, dispose() {} }; },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); }, onDidChangeActiveTextEditor() { return disposable(); },
      withProgress(options, task) { return task({ report() {} }); },
      setStatusBarMessage() {}, showErrorMessage() {}, showWarningMessage() { return Promise.resolve(undefined); },
      showInformationMessage() { return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { fsPath: workspace } }],
      createFileSystemWatcher(pattern) {
        const watcher = { pattern, handlers: [], dispose() {},
          onDidChange(h) { this.handlers.push(h); return disposable(); },
          onDidCreate(h) { this.handlers.push(h); return disposable(); },
          onDidDelete() { return disposable(); } };
        watchers.push(watcher);
        return watcher;
      },
      getConfiguration() {
        return {
          // VS Code's merge: folder over workspace over user. The value a machine-scoped read refuses.
          get: (key, fallback) => {
            const value = tiers[key];
            if (value) return value.workspaceFolderValue ?? value.workspaceValue ?? value.globalValue ?? fallback;
            return key === 'autoLearn.enabled' ? false : fallback;
          },
          inspect: (key) => tiers[key] || {},
          update: async () => {},
        };
      },
      onDidChangeConfiguration() { return disposable(); }, onDidChangeWorkspaceFolders() { return disposable(); },
      onDidSaveTextDocument() { return disposable(); }, onDidOpenTextDocument() { return disposable(); },
    },
  };
  const realChildProcess = require('node:child_process');
  const recorded = {
    ...realChildProcess,
    execFile(file, args, options, callback) {
      if (file !== python) return realChildProcess.execFile.apply(this, arguments);
      const done = typeof options === 'function' ? options : callback;
      compiles.push({ args, env: (typeof options === 'object' && options?.env) || {} });
      const child = new EventEmitter();
      setImmediate(() => { done(null, '', ''); child.emit('exit', 0, null); child.emit('close', 0, null); });
      return child;
    },
  };
  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME', 'CODEX_TOOLBOX'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex'), CODEX_TOOLBOX: path.join(home, 'toolbox') });
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
    if ((request === 'child_process' || request === 'node:child_process') && parent?.filename === extensionPath) return recorded;
    if (parent?.filename === extensionPath && request.startsWith('./src/')) {
      return originalLoad.call(this, path.join(rootSrc, request.slice('./src/'.length)), parent, isMain);
    }
    return originalLoad.call(this, request, parent, isMain);
  };
  const purge = () => {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(path.dirname(extensionPath) + path.sep)) delete require.cache[key];
    }
  };
  purge();
  const extension = require(extensionPath);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    try { await extension.deactivate(); } finally {
      Module._load = originalLoad;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      purge();
    }
  };
  t.after(close);
  try { extension.activate({ subscriptions: [] }); } catch (error) { await close(); throw error; }
  return { ...box, watchers, compiles, close, text: () => fs.readFileSync(claudeMd, 'utf8') };
}

// A compiled gates file, and (unless `install` is false) the block installed in CLAUDE.md:
// the state of a user who opted in, which is what arms the unattended recompile.
function gatesOptedIn(install = true) {
  return (box) => {
    fs.writeFileSync(path.join(box.home, '.claude', 'gates.generated.md'), '## Standing gates (1 memories, managed)\n\n- USER RULE\n');
    if (install) fs.writeFileSync(box.claudeMd, makeGatesBlock(box.home).apply(fs.readFileSync(box.claudeMd, 'utf8'), true).text);
  };
}

// The corpus the unattended recompile is handed after one edit of the user's own memory file.
// `memoryDir` maps the window's folders to the tiers memory.dir is set at.
async function corpusAfterMemoryEdit(t, memoryDir) {
  const app = await instructionWindow(t, (box) => ({
    ...(memoryDir ? { 'memory.dir': memoryDir(box) } : {}), 'guidance.enabled': { globalValue: false },
  }), gatesOptedIn());
  const watcher = app.watchers.find((w) => w.pattern?.pattern === '*.md' && w.pattern.base?.fsPath === app.store);
  assert.ok(watcher, 'precondition: the user\'s store has a gate-corpus watcher');
  for (const handler of watcher.handlers) handler({ fsPath: path.join(app.store, 'g.md') });
  const start = Date.now();
  while (!app.compiles.some((call) => call.args.includes('--gates-compile')) && Date.now() - start < 10000) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  await app.close();
  const compile = app.compiles.find((call) => call.args.includes('--gates-compile'));
  assert.ok(compile, 'precondition: one memory edit recompiled the gates, unattended');
  return { app, corpus: compile.env.RECALL_MEMORY_DIR };
}

test('the manifest declares memory.dir, gates.enabled and guidance.enabled machine-scoped', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'package.json'), 'utf8'));
  const properties = manifest.contributes?.configuration?.properties || {};
  // openThreads.enabled since 2026-10-19: it decides whether the same two files carry a third block.
  for (const key of ['memory.dir', 'gates.enabled', 'guidance.enabled', 'openThreads.enabled']) {
    const setting = properties[`permissionWildcarding.${key}`];
    assert.ok(setting, `precondition: ${key} is declared`);
    // MUTATION: drop `"scope": "machine"` from any one of the three. This fails. Confirmed 2026-10-14.
    assert.equal(setting.scope, 'machine', `${key}: any wider scope lets a workspace settings file decide what the global instruction files say`);
  }
});

test('a workspace-level memory.dir is never the corpus compiled into the global gates, and a user-level one is', async (t) => {
  const unset = await corpusAfterMemoryEdit(t, null);
  assert.equal(unset.corpus, unset.app.store, 'precondition: unset, the discovered store is compiled');
  // The hostile shape: a folder inside the repository, named by the repository's own settings.
  // MUTATION: read memory.dir with c.get() again in memoryLint.js cfg. The recompile is handed
  // the repository's folder and both of these fail. Confirmed 2026-10-14.
  const hostile = await corpusAfterMemoryEdit(t, (box) => ({ workspaceValue: box.planted }));
  assert.equal(hostile.corpus, hostile.app.store, 'the recompile read a corpus a workspace settings file chose');
  const folder = await corpusAfterMemoryEdit(t, (box) => ({ globalValue: box.elsewhere, workspaceFolderValue: box.planted }));
  assert.equal(folder.corpus, folder.app.elsewhere, 'a folder value outranked the user value for a machine-scoped key');
  // The control: the user tier is honoured.
  const user = await corpusAfterMemoryEdit(t, (box) => ({ globalValue: box.elsewhere }));
  assert.equal(user.corpus, user.app.elsewhere);
});

const hasGates = (text) => text.includes(GATES_BEGIN);
const hasGuidance = (text) => text.includes(GUIDANCE_BEGIN);

test('a workspace can neither install the gates block a user turned off, nor strip one the user keeps', async (t) => {
  const guidanceOff = { 'guidance.enabled': { globalValue: false } };
  // MUTATION: read gates.enabled with get() again in gatesEnabled (vscode-extension/extension.js).
  // Activation installs the block in the first window and strips it in the second. Confirmed 2026-10-14.
  const turnedOn = await instructionWindow(t, { ...guidanceOff, 'gates.enabled': { globalValue: false, workspaceValue: true } }, gatesOptedIn(false));
  assert.equal(hasGates(turnedOn.text()), false, 'a workspace value installed the gates block into the global CLAUDE.md');
  const turnedOff = await instructionWindow(t, { ...guidanceOff, 'gates.enabled': { workspaceValue: false } }, gatesOptedIn());
  assert.equal(hasGates(turnedOff.text()), true, 'a workspace value stripped the gates block from the global CLAUDE.md');
  // The controls: the user's own off removes it, and the default installs a compiled block.
  const userOff = await instructionWindow(t, { ...guidanceOff, 'gates.enabled': { globalValue: false } }, gatesOptedIn());
  assert.equal(hasGates(userOff.text()), false, 'the user\'s own off was not honoured');
  const byDefault = await instructionWindow(t, guidanceOff, gatesOptedIn(false));
  assert.equal(hasGates(byDefault.text()), true, 'the default no longer installs a compiled block');
});

test('a workspace can neither add the shell-style guidance block a user turned off, nor strip one the user keeps', async (t) => {
  const gatesOff = { 'gates.enabled': { globalValue: false } };
  const installed = (box) => fs.writeFileSync(box.claudeMd, applyGuidance(fs.readFileSync(box.claudeMd, 'utf8'), true).text);
  // MUTATION: read guidance.enabled with get() again in guidanceEnabled. Activation adds the
  // block in the first window and strips it in the second. Confirmed 2026-10-14.
  const turnedOn = await instructionWindow(t, { ...gatesOff, 'guidance.enabled': { globalValue: false, workspaceValue: true } });
  assert.equal(hasGuidance(turnedOn.text()), false, 'a workspace value added the guidance block to the global CLAUDE.md');
  const turnedOff = await instructionWindow(t, { ...gatesOff, 'guidance.enabled': { workspaceFolderValue: false } }, installed);
  assert.equal(hasGuidance(turnedOff.text()), true, 'a folder value stripped the guidance block from the global CLAUDE.md');
  // The controls: the user's own off removes it, and the default adds it.
  const userOff = await instructionWindow(t, { ...gatesOff, 'guidance.enabled': { globalValue: false } }, installed);
  assert.equal(hasGuidance(userOff.text()), false, 'the user\'s own off was not honoured');
  const byDefault = await instructionWindow(t, gatesOff);
  assert.equal(hasGuidance(byDefault.text()), true, 'the default no longer adds the block');
});
