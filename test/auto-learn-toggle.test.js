'use strict';

// TOGGLE AUTO LEARN, AND autoLearn.enabled MADE TIGHTEN-ONLY (2026-10-19).
//
// The owner asked why the Auto Learn card said "disabled" with no way to turn it on or off from
// the extension: autoLearn.enabled could only be changed in Settings. The Toggle Auto Learn
// command and the card's Turn on / Turn off button now flip it (toggleAutoLearn in
// vscode-extension/extension.js). The key also joined TIGHTEN_ONLY: off stops the background
// scans, and with them every unattended auto-safe apply, so a repository's .vscode/settings.json
// may turn Auto Learn off but never back on for a user who turned it off.
//
// A window over a temp home, as in test/workspace-tighten-only.test.js: the real extension, a
// configuration that answers tier by tier and writes back the tier update() names, and a scripted
// worker that records each operation. Two more observables. The periodic scan, found by its delay:
// autoLearn.intervalMinutes is 7 here, a period no other interval in the extension uses. And every
// modal, with its detail, because the file the toggle edits is named there.
//
// Harness copied, not shared, per the suite's standing decision
// (test/extension-activation.test.js:509#sharing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const TARGET = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const TIER = { [TARGET.Global]: 'globalValue', [TARGET.Workspace]: 'workspaceValue', [TARGET.WorkspaceFolder]: 'workspaceFolderValue' };
const KEY = 'autoLearn.enabled';
const TOGGLE = 'permission-wildcarding.toggleAutoLearn';
const CONFIRM = 'Remove and turn on';
const PERIOD_MS = 7 * 60 * 1000;
const disposable = () => ({ dispose() {} });
const realSetTimeout = setTimeout;
const settle = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms));
const strip = (line) => line.replace(/^\[[^\]]+\] /, '');

async function until(condition, ms, message) {
  const deadline = Date.now() + ms;
  while (!condition()) {
    if (Date.now() > deadline) assert.fail(message);
    await settle(20);
  }
}

// `tiers` maps a key (no section prefix) to the per-tier object inspect() returns. The two
// instruction-file blocks are off at the USER tier: not what this file is about.
// `answers` are the replies to queue for modal confirms; an empty queue is a dismissal, and a
// function is called for its answer, so a test can act while the modal is up.
// `onUpdate` runs inside each update(), after the write is recorded; `updateError` returns an
// Error for an update() that should fail, as VS Code's does on a settings file it cannot parse.
//
// ONE WINDOW AT A TIME: each one installs its own Module._load, HOME and interval hooks, so
// opening a second closes the first, and a test may open several in a row.
let openWindow = null;
async function windowOver(t, tiers = {}, options = {}) {
  if (openWindow) await openWindow();
  const { answers = [], onUpdate = null, updateError = () => null } = options;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-al-toggle-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2) + '\n');
  const workspace = path.join(home, 'repo');
  fs.mkdirSync(workspace, { recursive: true });
  const folders = options.folders || [workspace];
  const settings = {
    'guidance.enabled': { globalValue: false }, 'gates.enabled': { globalValue: false },
    'autoLearn.intervalMinutes': { globalValue: PERIOD_MS / 60000 },
    ...Object.fromEntries(Object.entries(tiers).map(([key, value]) => [key, { ...value }])),
  };

  const commands = new Map();
  const lines = [];
  const messages = [];
  const warnings = [];
  const errors = [];
  const updates = [];
  const runs = [];
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 }, ConfigurationTarget: TARGET,
    ProgressLocation: { Notification: 15 }, DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ThemeColor: class ThemeColor {}, Uri: { file: (p) => ({ fsPath: p }) },
    Range: class Range {}, Diagnostic: class Diagnostic {},
    languages: { createDiagnosticCollection() { return { set() {}, delete() {}, clear() {}, dispose() {} }; } },
    commands: { registerCommand(id, handler) { commands.set(id, handler); return disposable(); }, executeCommand() {} },
    window: {
      createOutputChannel() {
        return { appendLine(line) { lines.push(line); }, append() {}, show() {}, clear() { lines.length = 0; }, dispose() {} };
      },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); }, onDidChangeActiveTextEditor: disposable,
      withProgress(_options, task) { return task({ report() {} }); },
      setStatusBarMessage() { return disposable(); },
      showErrorMessage(message) { errors.push(message); },
      showWarningMessage(message, ...rest) {
        const modal = rest.length && typeof rest[0] === 'object' ? rest[0] : null;
        warnings.push({ message, modal: modal?.modal === true, detail: modal?.detail || '', actions: modal ? rest.slice(1) : rest });
        const answer = answers.shift();
        return Promise.resolve(typeof answer === 'function' ? answer() : answer);
      },
      showInformationMessage(message) { messages.push(message); return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: folders.map((folder) => ({ uri: { fsPath: folder } })),
      workspaceFile: options.workspaceFile,
      createFileSystemWatcher() {
        return { onDidChange: disposable, onDidCreate: disposable, onDidDelete: disposable, dispose() {} };
      },
      onDidSaveTextDocument: disposable, onDidOpenTextDocument: disposable,
      getConfiguration() {
        return {
          // VS Code's merge: folder over workspace over user over the default.
          get: (key, fallback) => {
            const value = settings[key] || {};
            return value.workspaceFolderValue ?? value.workspaceValue ?? value.globalValue ?? fallback;
          },
          inspect: (key) => settings[key] || {},
          // Writes the tier it is told to, and `undefined` removes the value there, as VS Code does.
          update: async (key, value, target) => {
            updates.push({ key, value, target });
            const failure = updateError(key, value, target);
            if (failure) throw failure;
            settings[key] = { ...(settings[key] || {}), [TIER[target]]: value };
            if (onUpdate) await onUpdate();
          },
        };
      },
      onDidChangeConfiguration() { return disposable(); }, onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };
  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  const saved = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: path.join(home, '.codex') });
  // The periodic scan, by its period. Unref'd, so one a failing test leaves armed cannot hold the
  // runner open.
  const periodic = new Set();
  const realSetInterval = global.setInterval;
  const realClearInterval = global.clearInterval;
  global.setInterval = (fn, ms, ...rest) => {
    const handle = realSetInterval(fn, ms, ...rest);
    if (typeof handle?.unref === 'function') handle.unref();
    if (ms === PERIOD_MS) periodic.add(handle);
    return handle;
  };
  global.clearInterval = (handle) => { periodic.delete(handle); return realClearInterval(handle); };
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
    if (parent?.filename === extensionPath && request === './autoLearnWorkerRunner') {
      return { createAutoLearnWorkerRunner: ({ optionsProvider }) => ({
        async run(operation, request = {}) { runs.push({ operation, request, options: optionsProvider() }); return {}; },
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
        memoryStoreDir: () => null,
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
  purge();
  const extension = require(extensionPath);
  let closed = false;
  const close = async () => {
    if (closed) return;
    closed = true;
    if (openWindow === close) openWindow = null;
    try { await extension.deactivate(); } finally {
      for (const handle of periodic) realClearInterval(handle);
      global.setInterval = realSetInterval;
      global.clearInterval = realClearInterval;
      Module._load = originalLoad;
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      purge();
    }
  };
  t.after(close);
  openWindow = close;
  try { extension.activate({ subscriptions: [] }); } catch (error) { await close(); throw error; }
  return {
    home, workspace, settings, lines, messages, warnings, errors, updates, runs, commands, close,
    // The command handler as VS Code holds it, which outlives deactivate() until the
    // subscriptions are disposed.
    toggle: () => commands.get(TOGGLE)(),
    review: () => commands.get('permission-wildcarding.autoLearnReview')(),
    applySafe: () => commands.get('permission-wildcarding.autoLearnApplySafe')(),
    deactivate: () => extension.deactivate(),
    answer: (...values) => answers.push(...values),
    // How many periodic Auto Learn scans are armed: 1 while on, 0 while off.
    armed: () => periodic.size,
    scans: () => runs.filter((entry) => entry.operation === 'scan'),
    toasts: () => messages.filter((message) => message.startsWith('Auto Learn is ')),
    ignored: (key) => lines.filter((line) => line.includes(` setting ${key}=`) && line.includes(' ignored: ')),
  };
}

test('the toggle turns Auto Learn off in user settings and disarms the periodic scan, then back on', async (t) => {
  const app = await windowOver(t);
  assert.equal(app.armed(), 1, 'precondition: with nothing set, activation armed the periodic scan');

  // MUTATION: drop resetAutoLearnTimer() from toggleAutoLearn. The scan stays armed and this
  // fails, because this harness, like a configuration event VS Code has not delivered yet, never
  // calls the listener. Confirmed 2026-10-19.
  await app.toggle();
  assert.deepEqual(app.updates, [{ key: KEY, value: false, target: TARGET.Global }]);
  assert.equal(app.armed(), 0, 'turning Auto Learn off left the periodic scan armed');
  assert.deepEqual(app.warnings, [], 'turning off asks nothing: it is the recoverable direction');
  const off = app.toasts().at(-1) || '';
  assert.match(off, /^Auto Learn is off, saved in your user settings\. The extension's background scans stop; Scan now still scans when you ask\./);
  assert.match(off, / Codex's after-turn Stop hook and the CLI's --learn are separate: neither reads this setting\./);

  await app.toggle();
  assert.deepEqual(app.updates.at(-1), { key: KEY, value: true, target: TARGET.Global });
  assert.equal(app.armed(), 1, 'turning Auto Learn back on did not re-arm the periodic scan');
  const on = app.toasts().at(-1) || '';
  assert.match(on, /^Auto Learn is on, saved in your user settings\. The extension's background scans of Claude Code and Codex history start again\./);
  assert.match(on, / Codex's after-turn Stop hook and the CLI's --learn are separate: neither reads this setting\.$/);
});

test('turning Auto Learn on writes user settings, re-arms the periodic scan and scans soon', async (t) => {
  const app = await windowOver(t, { [KEY]: { globalValue: false } });
  assert.equal(app.armed(), 0, 'precondition: off at activation, no periodic scan');
  // Past activation's first scan (750 ms), which a disabled window skips, so the only background
  // scan that can follow is one the toggle schedules.
  await settle(1200);
  assert.deepEqual(app.scans(), [], 'precondition: a disabled window ran no background scan');

  await app.toggle();
  assert.deepEqual(app.updates, [{ key: KEY, value: true, target: TARGET.Global }]);
  assert.deepEqual(app.warnings, [], 'with nothing at the workspace tier, turning on asks nothing');
  assert.equal(app.armed(), 1);
  // MUTATION: drop `if (next) scheduleAutoLearn(50)`. No scan follows and this times out.
  // Confirmed 2026-10-19.
  await until(() => app.scans().length > 0, 5000, 'turning Auto Learn on scheduled no scan');
});

test('a workspace true no longer turns on Auto Learn the user turned off, and a workspace false still turns it off', async (t) => {
  // MUTATION: read autoLearn.enabled with cfg.get() again in autoLearnConfig. This window arms the
  // periodic scan and fails. Confirmed 2026-10-19.
  const reopened = await windowOver(t, { [KEY]: { globalValue: false, workspaceValue: true } });
  assert.equal(reopened.armed(), 0, 'a workspace turned Auto Learn back on and armed the periodic scan');
  await reopened.review();
  assert.match(reopened.warnings.at(-1)?.message || '', /^Auto Learn is off\./, 'Review ran for a user who turned Auto Learn off');
  assert.deepEqual(reopened.ignored(KEY).map(strip), [
    'Settings: workspace setting autoLearn.enabled=true ignored: a workspace may only turn Auto Learn off (user setting: false).',
  ]);
  // A folder value is held to the same rule.
  const folder = await windowOver(t, { [KEY]: { globalValue: false, workspaceFolderValue: true } });
  assert.equal(folder.armed(), 0);
  assert.match(folder.ignored(KEY)[0] || '', /^\[[^\]]+\] Settings: folder setting autoLearn\.enabled=true ignored/);

  // The other direction is allowed: a workspace's off holds over the user's on (here the default),
  // and is not an ignored value.
  // MUTATION: return `user` alone from tightenOnlySetting. This window arms the scan. Confirmed
  // 2026-10-19.
  const closed = await windowOver(t, { [KEY]: { workspaceValue: false } });
  assert.equal(closed.armed(), 0, 'a workspace could not turn Auto Learn off');
  assert.deepEqual(closed.ignored(KEY), []);
  // The control: a workspace true over the default is no looser, so it is not logged either.
  const control = await windowOver(t, { [KEY]: { workspaceValue: true } });
  assert.equal(control.armed(), 1);
  assert.deepEqual(control.ignored(KEY), []);
});

test('turning on over a workspace false asks first and names the file, and a dismissal writes nothing', async (t) => {
  const app = await windowOver(t, { [KEY]: { globalValue: false, workspaceValue: false } });
  const file = path.join(app.workspace, '.vscode', 'settings.json');
  // MUTATION: skip the modal (treat every answer as the confirm). The dismissal below writes
  // both tiers and this fails. Confirmed 2026-10-19.
  await app.toggle();
  assert.equal(app.warnings.length, 1, 'turning on over a workspace false did not ask');
  const [ask] = app.warnings;
  assert.equal(ask.message, 'Turn on Auto Learn in this window?');
  assert.equal(ask.modal, true);
  assert.deepEqual(ask.actions, [CONFIRM]);
  assert.ok(ask.detail.startsWith(`${file} turns Auto Learn off here, and a workspace setting may only turn it off.`), ask.detail);
  assert.ok(ask.detail.includes(`removes permissionWildcarding.autoLearn.enabled from ${file}. If the repository commits that file`), ask.detail);
  assert.deepEqual(app.updates, [], 'a dismissed confirm wrote a setting');
  assert.equal(app.armed(), 0);
  assert.deepEqual(app.toasts(), []);

  app.answer(CONFIRM);
  await app.toggle();
  // MUTATION: skip the loop that removes the capping values. The user tier is written but the
  // workspace false still holds this window off, so nothing is armed. Confirmed 2026-10-19.
  assert.deepEqual(app.updates, [
    { key: KEY, value: true, target: TARGET.Global },
    { key: KEY, value: undefined, target: TARGET.Workspace },
  ]);
  assert.equal(app.armed(), 1, 'the toggle reported Auto Learn on, and the workspace false still held it off');
  assert.ok((app.toasts().at(-1) || '').includes(` The setting in ${file} that turned it off here was removed.`), app.toasts().at(-1));
});

test('the modal names the file each tier lives in, once each', async (t) => {
  // A folder value, in a single-folder window: the folder's .vscode/settings.json, and the folder
  // tier is the one removed.
  const folder = await windowOver(t, { [KEY]: { globalValue: false, workspaceFolderValue: false } }, { answers: [CONFIRM] });
  await folder.toggle();
  const file = path.join(folder.workspace, '.vscode', 'settings.json');
  assert.ok(folder.warnings[0]?.detail.startsWith(`${file} turns Auto Learn off here`), folder.warnings[0]?.detail);
  assert.deepEqual(folder.updates.map((update) => update.target), [TARGET.Global, TARGET.WorkspaceFolder]);
  assert.equal(folder.armed(), 1);

  // Both tiers in one folder are one file, named once.
  // MUTATION: name each cap's file without the de-duplication. This names the file twice and
  // fails. Confirmed 2026-10-19.
  const both = await windowOver(t, { [KEY]: { workspaceValue: false, workspaceFolderValue: false } });
  await both.toggle();
  const bothFile = path.join(both.workspace, '.vscode', 'settings.json');
  assert.equal(both.warnings[0]?.detail.split(bothFile).length - 1, 2, `named once, then once more in "removes … from": ${both.warnings[0]?.detail}`);

  // A multi-root window keeps its workspace tier in the .code-workspace file.
  // MUTATION: ignore vscode.workspace.workspaceFile in workspaceSettingsFile. This names a
  // .vscode/settings.json instead and fails. Confirmed 2026-10-19.
  const second = path.join(os.tmpdir(), 'acolyte-al-toggle-second');
  const codeWorkspace = { fsPath: path.join(os.tmpdir(), 'team.code-workspace'), scheme: 'file' };
  const multi = await windowOver(t, { [KEY]: { workspaceValue: false } },
    { workspaceFile: codeWorkspace, folders: [path.join(os.tmpdir(), 'acolyte-al-toggle-first'), second] });
  await multi.toggle();
  assert.ok(multi.warnings[0]?.detail.startsWith(`${codeWorkspace.fsPath} turns Auto Learn off here`), multi.warnings[0]?.detail);
  // An untitled one has no file of its own to name.
  // MUTATION: drop the scheme check. This names the untitled workspace's fsPath and fails.
  // Confirmed 2026-10-19.
  const untitled = await windowOver(t, { [KEY]: { workspaceValue: false } },
    { workspaceFile: { fsPath: '/Untitled (Workspace)', scheme: 'untitled' }, folders: [second, second + '-b'] });
  await untitled.toggle();
  assert.ok(untitled.warnings[0]?.detail.startsWith("this untitled workspace's settings turns Auto Learn off here"), untitled.warnings[0]?.detail);
  // A folder value in a multi-root window could be any folder's.
  // MUTATION: name the first folder's file whatever the folder count. This fails. Confirmed
  // 2026-10-19.
  const anyFolder = await windowOver(t, { [KEY]: { workspaceFolderValue: false } }, { folders: [second, second + '-b'] });
  await anyFolder.toggle();
  assert.ok(anyFolder.warnings[0]?.detail.startsWith("the folder's .vscode/settings.json turns Auto Learn off here"), anyFolder.warnings[0]?.detail);
});

test('a toggle after deactivate, answered after it, or whose write spans it, goes no further', async (t) => {
  // The command stays registered with VS Code until the subscriptions are disposed.
  // MUTATION: drop the `if (deactivated) return;` at the top of toggleAutoLearn. This writes user
  // settings and toasts, and fails. Confirmed 2026-10-19.
  const after = await windowOver(t);
  await after.deactivate();
  await after.toggle();
  assert.deepEqual(after.updates, [], 'a toggle after deactivate wrote a setting');
  assert.deepEqual(after.toasts(), []);

  // A modal answered after teardown.
  // MUTATION: drop `|| deactivated` from the check after the modal. This writes both tiers.
  // Confirmed 2026-10-19.
  const modal = await windowOver(t, { [KEY]: { globalValue: false, workspaceValue: false } }, {
    answers: [async () => { await modal.deactivate(); return CONFIRM; }],
  });
  await modal.toggle();
  assert.equal(modal.warnings.length, 1, 'precondition: the modal was shown');
  assert.deepEqual(modal.updates, [], 'a confirm answered after teardown still wrote settings');

  // A write that spans teardown. The setting is saved, it is what the user asked for, and nothing
  // after it runs.
  // MUTATION: drop the `if (deactivated) return;` after the writes. This toasts and fails.
  // Confirmed 2026-10-19.
  const spans = await windowOver(t, {}, { onUpdate: async () => { await spans.deactivate(); } });
  await spans.toggle();
  assert.deepEqual(spans.updates, [{ key: KEY, value: false, target: TARGET.Global }]);
  assert.deepEqual(spans.toasts(), [], 'a toggle whose write spanned teardown still reported');
});

test('a failed user-settings write leaves the workspace value alone and says so', async (t) => {
  const app = await windowOver(t, { [KEY]: { globalValue: false, workspaceValue: false } }, {
    answers: [CONFIRM],
    updateError: (key, value, target) => (target === TARGET.Global ? new Error('Unable to write into user settings.') : null),
  });
  // MUTATION: remove the capping values before the user-tier write. The workspace false is gone
  // although nothing was switched on, and this fails. Confirmed 2026-10-19.
  await app.toggle();
  assert.deepEqual(app.updates, [{ key: KEY, value: true, target: TARGET.Global }], 'only the failed user write was attempted');
  assert.equal(app.settings[KEY].workspaceValue, false, 'the workspace value was removed though nothing was switched on');
  // MUTATION: drop the `return` in the catch. This toasts "Auto Learn is on" and fails.
  // Confirmed 2026-10-19.
  assert.deepEqual(app.errors, ['AI Acolyte: Auto Learn was not switched: Unable to write into user settings.']);
  assert.deepEqual(app.toasts(), []);
  assert.equal(app.armed(), 0);
});

test('every command title the Auto Learn messages quote is one the manifest contributes', async (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'package.json'), 'utf8'));
  const titles = new Set(manifest.contributes.commands.map((entry) => entry.title));
  assert.equal(manifest.contributes.commands.find((entry) => entry.command === TOGGLE)?.title, 'AI Acolyte: Toggle Auto Learn');
  const app = await windowOver(t, { [KEY]: { globalValue: false } });
  assert.ok(app.commands.has(TOGGLE), 'activation registers the toggle');
  // Review and Apply safe, refused while off, now say how to turn it on.
  await app.review();
  await app.applySafe();
  assert.deepEqual(app.warnings.map((warning) => warning.message), [
    'Auto Learn is off. Turn it on with "AI Acolyte: Toggle Auto Learn" or the Auto Learn card before reviewing candidates.',
    'Auto Learn is off. Turn it on with "AI Acolyte: Toggle Auto Learn" or the Auto Learn card before applying policy.',
  ]);
  await app.toggle();
  await app.toggle();
  // A title quoted in a message and renamed in the manifest is a dead end: the reader searches
  // the palette for a command that is not there.
  const said = [...app.warnings.map((warning) => warning.message), ...app.toasts(),
    manifest.contributes.configuration.properties['permissionWildcarding.autoLearn.enabled'].markdownDescription].join('\n');
  const quoted = [...said.matchAll(/["*]{1,2}(AI Acolyte: [^"*]+)["*]{1,2}/g)].map((match) => match[1]);
  assert.ok(quoted.includes('AI Acolyte: Toggle Auto Learn') && quoted.includes('AI Acolyte: Configure Codex after-turn learning'),
    `precondition: the messages quote both titles: ${JSON.stringify(quoted)}`);
  const unknown = quoted.filter((title) => !titles.has(title));
  assert.deepEqual(unknown, [], `messages quote titles the manifest does not contribute: ${unknown.join(', ')}`);
});
