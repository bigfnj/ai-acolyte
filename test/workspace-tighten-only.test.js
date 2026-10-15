'use strict';

// A WORKSPACE MAY MAKE AUTO LEARN AND THE DRAIN STRICTER, NEVER LOOSER (the maintainer's
// decision of 2026-10-15).
//
// wave-f15's settings census ("The settings census behind S2", docs/engineering-record.md) found
// four window-scoped keys that decide whether the extension writes the user's global files
// unattended. In `auto-safe` every scan applies grants to ~/.claude/settings.json and
// ~/.codex/rules with no modal, `successThreshold` is how much evidence that takes,
// `codexScope: user` lets an apply write the Codex rules, and `localDrain.enabled` promotes a
// workspace's settings.local.json into user scope. All four were read with get(), so a
// repository's .vscode/settings.json could opt the user into any of them. They are now read
// through tightenOnlySetting (vscode-extension/extension.js): the strictest of the user tier and
// every workspace or folder value no looser than it. A looser value is ignored with one output
// line. The mode toggle writes user settings for a step above the user's own mode.
//
// A window over a temp home: the real extension, a configuration that answers tier by tier as
// VS Code merges it and writes back the tier update() names, and a scripted Auto Learn worker
// that records what each operation was handed. Nothing is scanned for real. The request a scan
// is handed (mode, threshold), the options the worker is built from (the Codex rules path), what
// activation's drain left in settings.json, and the output channel are the observables.
//
// Harness copied, not shared, per the suite's standing decision
// (test/extension-activation.test.js:505#sharing).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const TARGET = { Global: 1, Workspace: 2, WorkspaceFolder: 3 };
const TIER = { [TARGET.Global]: 'globalValue', [TARGET.Workspace]: 'workspaceValue', [TARGET.WorkspaceFolder]: 'workspaceFolderValue' };
const disposable = () => ({ dispose() {} });

// `tiers` maps a key (no section prefix) to the per-tier object inspect() returns. Background
// scans and the two instruction-file blocks are off at the USER tier: not what this file is about.
// `local` is the workspace's .claude/settings.local.json allow list, drained on activation.
// `answers` are the replies to queue for modal confirms; an empty queue is a dismissal.
//
// ONE WINDOW AT A TIME: each one installs its own Module._load and HOME, so opening a second
// closes the first, and a test may open several in a row.
let openWindow = null;
async function windowOver(t, tiers = {}, { local = null, answers = [] } = {}) {
  if (openWindow) await openWindow();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-tighten-only-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const settingsPath = path.join(home, '.claude', 'settings.json');
  fs.mkdirSync(path.dirname(settingsPath), { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify({ permissions: { allow: [], deny: [] } }, null, 2) + '\n');
  const workspace = path.join(home, 'repo');
  fs.mkdirSync(path.join(workspace, '.claude'), { recursive: true });
  if (local) {
    fs.writeFileSync(path.join(workspace, '.claude', 'settings.local.json'),
      JSON.stringify({ permissions: { allow: local } }, null, 2) + '\n');
  }
  const settings = {
    'autoLearn.enabled': { globalValue: false }, 'guidance.enabled': { globalValue: false },
    'gates.enabled': { globalValue: false },
    ...Object.fromEntries(Object.entries(tiers).map(([key, value]) => [key, { ...value }])),
  };

  const commands = new Map();
  const lines = [];
  const messages = [];
  const warnings = [];
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
      withProgress(options, task) { return task({ report() {} }); },
      setStatusBarMessage() { return disposable(); }, showErrorMessage() {},
      showWarningMessage(message) { warnings.push(message); return Promise.resolve(answers.shift()); },
      showInformationMessage(message) { messages.push(message); return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { fsPath: workspace } }],
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
            settings[key] = { ...(settings[key] || {}), [TIER[target]]: value };
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
    home, settings, lines, messages, warnings, updates, close,
    userAllow: () => JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions.allow,
    // What one manual scan hands the worker: the request (mode, threshold) and the options the
    // worker's manager is built from (where Codex rules would be written).
    async scan() {
      const before = runs.length;
      await commands.get('permission-wildcarding.autoLearnScan')();
      const run = runs.slice(before).find((entry) => entry.operation === 'scan');
      assert.ok(run, `precondition: the scan reached the worker: ${JSON.stringify(runs.map((entry) => entry.operation))}`);
      return { mode: run.request.mode, threshold: run.request.threshold, codexRulesPath: run.options.codexRulesPath };
    },
    cycle: () => commands.get('permission-wildcarding.autoLearnCycleMode')(),
    ignored: (key) => lines.filter((line) => line.includes(` setting ${key}=`) && line.includes(' ignored: ')),
  };
}

test('with nothing set, Auto Learn and the drain keep their defaults and nothing is logged', async (t) => {
  const manifest = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'vscode-extension', 'package.json'), 'utf8'));
  const properties = manifest.contributes.configuration.properties;
  // The fallbacks tightenOnlySetting uses are the manifest's own defaults, and the four keys
  // stay window-scoped: a workspace must still be able to make each one stricter.
  for (const [key, fallback] of [['autoLearn.mode', 'recommend'], ['autoLearn.successThreshold', 3],
    ['autoLearn.codexScope', 'user'], ['localDrain.enabled', true]]) {
    const setting = properties[`permissionWildcarding.${key}`];
    assert.equal(setting.default, fallback, `precondition: ${key} still defaults to ${fallback}`);
    assert.equal(setting.scope, undefined, `${key} must stay window-scoped, or a workspace can no longer tighten it`);
  }
  const app = await windowOver(t, {}, { local: ['Bash(dotnet build src/App.csproj)'] });
  // MUTATION: change TIGHTEN_ONLY's autoLearn.mode fallback to 'observe', or its threshold
  // fallback to 1. This fails. Confirmed 2026-10-15.
  const scan = await app.scan();
  assert.equal(scan.mode, 'recommend');
  assert.equal(scan.threshold, 3);
  assert.equal(scan.codexRulesPath, path.join(app.home, '.codex', 'rules', 'permission-wildcarding.rules'),
    'unset, Codex rule export is on at user scope');
  assert.ok(app.userAllow().includes('Bash(dotnet build *)'), 'unset, activation drains the project-local file');
  assert.deepEqual(app.lines.filter((line) => line.includes(' ignored: ')), []);
});

test('a workspace auto-safe over a user recommend is ignored, with one output line', async (t) => {
  // MUTATION: read autoLearn.mode with cfg.get() again in autoLearnConfig. Every scan here is
  // handed auto-safe. Confirmed 2026-10-15.
  const app = await windowOver(t, { 'autoLearn.mode': { globalValue: 'recommend', workspaceValue: 'auto-safe' } });
  assert.equal((await app.scan()).mode, 'recommend', 'a workspace raised the mode above the user\'s own');
  // autoLearnConfig runs on every scan and every refresh; the line is written once.
  // MUTATION: drop the looserSettingsNoted check in noteLooserSettingIgnored. This fails on the
  // count. Confirmed 2026-10-15.
  await app.scan();
  assert.deepEqual(app.ignored('autoLearn.mode').map((line) => line.replace(/^\[[^\]]+\] /, '')), [
    'Settings: workspace setting autoLearn.mode=auto-safe ignored: a workspace may only lower the mode (user setting: recommend).',
  ]);

  // The user never set one: the default is what a workspace cannot exceed.
  const unset = await windowOver(t, { 'autoLearn.mode': { workspaceValue: 'auto-safe' } });
  assert.equal((await unset.scan()).mode, 'recommend');
  assert.match(unset.ignored('autoLearn.mode')[0] || '', /\(user setting: recommend, the default\)\.$/);
  // A folder value is held to the same rule.
  const folder = await windowOver(t, { 'autoLearn.mode': { globalValue: 'observe', workspaceFolderValue: 'recommend' } });
  assert.equal((await folder.scan()).mode, 'observe');
  assert.match(folder.ignored('autoLearn.mode')[0] || '', /^\[[^\]]+\] Settings: folder setting autoLearn\.mode=recommend ignored/);
});

test('a workspace observe under a user recommend takes effect, and a folder cannot raise it back', async (t) => {
  // MUTATION: return `user` alone from tightenOnlySetting (reading these keys as if machine-scoped).
  // The first two windows are handed the user's mode and this fails. Confirmed 2026-10-15.
  const lowered = await windowOver(t, { 'autoLearn.mode': { globalValue: 'recommend', workspaceValue: 'observe' } });
  assert.equal((await lowered.scan()).mode, 'observe', 'a workspace could not lower the mode');
  assert.deepEqual(lowered.ignored('autoLearn.mode'), [], 'a lowering is not an ignored value');
  const recommend = await windowOver(t, { 'autoLearn.mode': { globalValue: 'auto-safe', workspaceValue: 'recommend' } });
  assert.equal((await recommend.scan()).mode, 'recommend');
  // VS Code's merge lets the folder win, which would undo the workspace's lowering by going above
  // the user. The reverted get() is handed auto-safe here.
  const undone = await windowOver(t, { 'autoLearn.mode': { globalValue: 'recommend', workspaceValue: 'observe', workspaceFolderValue: 'auto-safe' } });
  assert.equal((await undone.scan()).mode, 'observe', 'a folder value above the user tier undid the workspace\'s lowering');
  assert.equal(undone.ignored('autoLearn.mode').length, 1);
});

test('a workspace threshold below the user\'s is ignored, and one above it takes effect', async (t) => {
  // MUTATION: read autoLearn.successThreshold with cfg.get() again. The first window is handed 1.
  // Confirmed 2026-10-15.
  const looser = await windowOver(t, { 'autoLearn.successThreshold': { globalValue: 5, workspaceValue: 1 } });
  assert.equal((await looser.scan()).threshold, 5, 'a workspace lowered the bar below the user\'s own');
  assert.deepEqual(looser.ignored('autoLearn.successThreshold').map((line) => line.replace(/^\[[^\]]+\] /, '')), [
    'Settings: workspace setting autoLearn.successThreshold=1 ignored: a workspace may only raise the threshold (user setting: 5).',
  ]);
  const unset = await windowOver(t, { 'autoLearn.successThreshold': { workspaceValue: 1 } });
  assert.equal((await unset.scan()).threshold, 3, 'with no user value, the default is the floor a workspace keeps');
  // Stricter is allowed: this is the per-project choice the rule keeps.
  // MUTATION: return `user` alone from tightenOnlySetting. This is handed 5. Confirmed 2026-10-15.
  const stricter = await windowOver(t, { 'autoLearn.successThreshold': { globalValue: 5, workspaceValue: 8 } });
  assert.equal((await stricter.scan()).threshold, 8);
  assert.deepEqual(stricter.ignored('autoLearn.successThreshold'), []);
});

test('the mode toggle writes user settings to raise the mode, and the workspace tier to lower it', async (t) => {
  // RAISE. The workspace holds recommend explicitly, equal to the user's. The old toggle wrote
  // auto-safe into the workspace tier, which a workspace may no longer use to go above the user.
  // MUTATION: restore the old target choice (folder, else workspace, else user, whatever the
  // step). This writes the workspace tier and fails. Confirmed 2026-10-15.
  const raise = await windowOver(t, { 'autoLearn.mode': { globalValue: 'recommend', workspaceValue: 'recommend' } },
    { answers: ['Enable auto-safe'] });
  await raise.cycle();
  assert.deepEqual(raise.updates.filter((u) => u.key === 'autoLearn.mode'), [
    { key: 'autoLearn.mode', value: 'auto-safe', target: TARGET.Global },
    // The workspace's recommend would still cap this window, so the raise removes it.
    // MUTATION: skip the removal loop. This fails here, and the scan below would be handed
    // recommend. Confirmed 2026-10-15.
    { key: 'autoLearn.mode', value: undefined, target: TARGET.Workspace },
  ]);
  assert.match(raise.warnings[0] || '', /in your user settings, for every workspace that does not lower it\?/,
    'the auto-safe confirm says it is a user setting');
  assert.equal((await raise.scan()).mode, 'auto-safe', 'the toggle reported a mode this window did not get');
  assert.match(raise.messages.find((m) => m.startsWith('Auto Learn mode:')) || '',
    /^Auto Learn mode: auto-safe, saved in your user settings\. A workspace may only lower the mode/);

  // A raise past an IGNORED workspace value: the user tier is written and the value is left alone,
  // because it no longer caps anything.
  const past = await windowOver(t, { 'autoLearn.mode': { globalValue: 'observe', workspaceValue: 'auto-safe' } });
  await past.cycle();
  assert.deepEqual(past.updates.filter((u) => u.key === 'autoLearn.mode'),
    [{ key: 'autoLearn.mode', value: 'recommend', target: TARGET.Global }]);
  assert.equal((await past.scan()).mode, 'recommend');

  // LOWER. auto-safe wraps to observe, below the user's auto-safe, and the workspace already holds
  // a value: the workspace tier is written, so a stricter per-project choice still sticks.
  // MUTATION: always write the user tier. This fails on the target. Confirmed 2026-10-15.
  const lower = await windowOver(t, { 'autoLearn.mode': { globalValue: 'auto-safe', workspaceValue: 'auto-safe' } });
  await lower.cycle();
  assert.deepEqual(lower.updates.filter((u) => u.key === 'autoLearn.mode'),
    [{ key: 'autoLearn.mode', value: 'observe', target: TARGET.Workspace }]);
  assert.equal((await lower.scan()).mode, 'observe');
  assert.equal(lower.settings['autoLearn.mode'].globalValue, 'auto-safe', 'lowering one workspace left the user setting alone');
  // The toast names the tier it wrote. The old one said only "Auto Learn mode: observe."
  assert.ok(lower.messages.includes('Auto Learn mode: observe, saved in this workspace\'s settings.'), JSON.stringify(lower.messages));
  // Back up to the user's own mode from below it is not a raise either: still the workspace tier.
  await lower.cycle();
  assert.deepEqual(lower.updates.at(-1), { key: 'autoLearn.mode', value: 'recommend', target: TARGET.Workspace });
});

test('a workspace may turn Codex rule export off, never back on for a user who chose off', async (t) => {
  // MUTATION: read autoLearn.codexScope with cfg.get() again in autoLearnConfig. The first
  // window's worker is handed the user rule file. Confirmed 2026-10-15.
  const reopened = await windowOver(t, { 'autoLearn.codexScope': { globalValue: 'off', workspaceValue: 'user' } });
  assert.equal((await reopened.scan()).codexRulesPath, null, 'a workspace turned Codex rule export back on');
  assert.deepEqual(reopened.ignored('autoLearn.codexScope').map((line) => line.replace(/^\[[^\]]+\] /, '')), [
    'Settings: workspace setting autoLearn.codexScope=user ignored: a workspace may only turn Codex rule export off (user setting: off).',
  ]);
  // The other direction is allowed, and the withdrawn `workspace` value still writes nothing,
  // whichever tier holds it, with no line, since it is not looser than off.
  const closed = await windowOver(t, { 'autoLearn.codexScope': { workspaceValue: 'off' } });
  assert.equal((await closed.scan()).codexRulesPath, null, 'a workspace could not turn Codex rule export off');
  const withdrawn = await windowOver(t, { 'autoLearn.codexScope': { globalValue: 'off', workspaceValue: 'workspace' } });
  assert.equal((await withdrawn.scan()).codexRulesPath, null);
  assert.deepEqual(withdrawn.ignored('autoLearn.codexScope'), []);
});

test('a workspace may turn the automatic drain off, never back on for a user who turned it off', async (t) => {
  const local = ['Bash(dotnet build src/App.csproj)'];
  // MUTATION: read localDrain.enabled with get() again in localDrainEnabled. Activation drains
  // the repository's file into user scope and this fails. Confirmed 2026-10-15.
  const reopened = await windowOver(t, { 'localDrain.enabled': { globalValue: false, workspaceValue: true } }, { local });
  assert.deepEqual(reopened.userAllow(), [], 'a workspace turned the drain back on and it promoted into user scope');
  assert.deepEqual(reopened.ignored('localDrain.enabled').map((line) => line.replace(/^\[[^\]]+\] /, '')), [
    'Settings: workspace setting localDrain.enabled=true ignored: a workspace may only turn the automatic drain off (user setting: false).',
  ]);
  // The other direction is allowed: a workspace's off holds with the user's on (here, the default).
  // MUTATION: return `user` alone from tightenOnlySetting. This window drains. Confirmed 2026-10-15.
  const closed = await windowOver(t, { 'localDrain.enabled': { workspaceValue: false } }, { local });
  assert.deepEqual(closed.userAllow(), [], 'a workspace could not turn the drain off');
  // The control: with the user's own on and nothing at the workspace, activation drains.
  const control = await windowOver(t, { 'localDrain.enabled': { globalValue: true } }, { local });
  assert.ok(control.userAllow().includes('Bash(dotnet build *)'));
});
