#!/usr/bin/env node
// Drive the INSTALLED extension, not the checkout.
//
// scripts/verify-release.ps1 only HASHES the installed extension.js against the repo
// source; nothing in the tree loads and runs the installed copy. docs/codex-certification.md
// records that gap as "the extension half was not clicked through". This closes the
// automatable part of it: activation from the packaged artefact, the real command
// handlers, and a scan/apply/undo round trip through the files VS Code actually loads.
//
// It cannot click a button. What it proves is that the PACKAGED artefact activates and
// its commands work, which is the half that has silently broken here before (a worker
// spawned by PATH found no module because the packaged layout differs from the repo).
//
// Writes NOTHING to the real ~/.claude: os.homedir() is stubbed before the extension is
// required, and the stub is asserted to have taken before anything runs.
//
//   node scripts/drive-installed.js [version]      default 1.5.2
//
// Local only, like scripts/smoke.sh and scripts/verify-release.ps1: it needs the VSIX
// actually installed, which CI has no way to arrange.
//
// TWO WARNINGS FOR ANYONE EXTENDING THE STUB, both learned the hard way while writing it.
// The extension CATCHES a subsystem activation failure and keeps going, so "activate()
// completed" passes over a memoryLint that never ran — the subscription count is the tell
// (36 with it dead, 41 alive). And it reports that failure through console.error, not
// through the vscode stub, so the guard added to catch it passed anyway until it watched
// both channels. A stub with a hole makes this harness assert less than it claims, in a
// way that looks like success.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('node:module');
const assert = require('node:assert/strict');

const VERSION = process.argv[2] || '1.5.2';
const INSTALLED = path.join(os.homedir(), '.vscode', 'extensions',
  `local.permission-wildcarding-${VERSION}`);
const entry = path.join(INSTALLED, 'extension.js');

if (!fs.existsSync(entry)) {
  console.error(`no installed extension at ${entry}`);
  process.exit(2);
}

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-installed-drive-'));
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
  JSON.stringify({ permissions: { allow: ['Bash(git status *)'], deny: [], ask: [] } }, null, 2));

// A transcript the scan can actually learn from, in the real Claude shape.
const projectDir = path.join(home, '.claude', 'projects', 'drive');
fs.mkdirSync(projectDir, { recursive: true });
const lines = [];
for (let i = 0; i < 6; i += 1) {
  lines.push(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `call_${i}`, name: 'Bash', input: { command: 'rg --files' } }] },
    cwd: home,
  }));
  lines.push(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: `call_${i}`, is_error: false, content: 'ok' }] },
    cwd: home,
  }));
}
fs.writeFileSync(path.join(projectDir, 'session.jsonl'), lines.join('\n') + '\n');

const commands = new Map();
const shown = [];

// console.error is a real reporting channel for this extension, so the harness has to
// watch it as well as the vscode stub. Recorded AND still printed, so a failure is
// visible in the transcript rather than only in a counter.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => {
  stderrLines.push(args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' '));
  realConsoleError.apply(console, args);
};
const vscode = {
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: home } }],
    getConfiguration: () => ({ get: (_k, d) => d }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    // Missing from the first version of this harness, and the cost was real: the
    // extension CAUGHT the resulting TypeError and logged "memory lint failed to
    // activate", so "activate() completes" still passed while memoryLint had not run
    // at all. An incomplete stub makes a harness assert less than it claims.
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    textDocuments: [],
    fs: { stat: () => Promise.resolve({}) },
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    }),
  },
  window: {
    showInformationMessage: (m) => { shown.push(String(m)); return Promise.resolve(undefined); },
    showWarningMessage: (m) => { shown.push(String(m)); return Promise.resolve(undefined); },
    showErrorMessage: (m) => { shown.push(`ERROR ${m}`); return Promise.resolve(undefined); },
    setStatusBarMessage: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
    createOutputChannel: () => ({ appendLine() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showQuickPick: () => Promise.resolve(undefined),
    withProgress: (_o, task) => task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: () => Promise.resolve(),
  },
  languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
  Uri: { file: (p) => ({ fsPath: p }) },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  ThemeIcon: class {},
  ConfigurationTarget: { Global: 1 },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request === 'os') return { ...os, homedir: () => home };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const results = [];
  const ok = (name, detail) => { results.push(['PASS', name, detail || '']); };
  const bad = (name, detail) => { results.push(['FAIL', name, detail || '']); };

  let extension;
  try {
    extension = require(entry);
  } catch (error) {
    bad('the installed extension loads', error.message);
    report(results);
    return;
  }
  ok('the installed extension loads', entry);

  // The stub has to have taken before anything else is believable.
  const probedHome = require(path.join(INSTALLED, 'src', 'permissions.js'));
  assert.ok(probedHome, 'precondition: the packaged src/ is reachable from the installed layout');
  ok('the packaged src/ tree is present and requirable', 'src/permissions.js');

  const subscriptions = [];
  try {
    await extension.activate({ subscriptions });
    ok('activate() completes against the packaged artefact', `${subscriptions.length} subscriptions`);
  } catch (error) {
    bad('activate() completes against the packaged artefact', error.message);
    report(results);
    return;
  }

  const expected = [
    'permission-wildcarding.runNow',
    'permission-wildcarding.autoLearnScan',
    'permission-wildcarding.autoLearnApplySafe',
    'permission-wildcarding.autoLearnUndo',
    'permission-wildcarding.autoLearnWhy',
    'permission-wildcarding.drainLocal',
  ];
  const missing = expected.filter((id) => !commands.has(id));
  if (missing.length) bad('the real command handlers registered', `missing: ${missing.join(', ')}`);
  else ok('the real command handlers registered', `${commands.size} commands`);

  // "activate() completes" is satisfied by an activation that swallowed a subsystem
  // failure, which is exactly what happened on the first run of this harness. Assert
  // no subsystem reported itself dead.
  //
  // The FIRST version of this check read only `shown`, the vscode-stub message log, and
  // passed against a real failure — the extension reports that one through console.error,
  // which never touches the stub. A check watching one channel while the thing it guards
  // speaks on another is the same vacuity this whole effort has been hunting, reproduced
  // twice inside the harness written to verify the fixes for it.
  const activationFailures = [...shown, ...stderrLines]
    .filter((m) => /failed to activate|ERROR /.test(m));
  if (activationFailures.length) {
    bad('no subsystem reported a failed activation', activationFailures.join(' | '));
  } else {
    ok('no subsystem reported a failed activation');
  }

  // The retired MAX ids must still be reachable, because an existing keybinding
  // calls them, and they must route to cleanup rather than to an enable path.
  for (const id of ['permission-wildcarding.toggleMax', 'permission-wildcarding.toggleCodexMax']) {
    if (commands.has(id)) ok(`${id} is still reachable after the retirement`);
    else bad(`${id} is still reachable after the retirement`, 'an existing keybinding would error');
  }

  try {
    await commands.get('permission-wildcarding.autoLearnScan')();
    ok('a scan runs through the installed worker', 'no throw');
  } catch (error) {
    bad('a scan runs through the installed worker', error.message);
  }

  const stateDir = path.join(home, '.claude', 'wildcarding');
  const stateFile = fs.existsSync(stateDir)
    ? fs.readdirSync(stateDir).find((f) => f.startsWith('auto-learn-state'))
    : null;
  if (stateFile) {
    const state = JSON.parse(fs.readFileSync(path.join(stateDir, stateFile), 'utf8'));
    const n = Object.keys(state.candidates || {}).length;
    if (n > 0) ok('the scan learned from the transcript', `${n} candidate(s), lastScanAt ${state.lastScanAt}`);
    else bad('the scan learned from the transcript', 'zero candidates from 6 successful runs');
  } else {
    bad('the scan wrote state', `nothing under ${stateDir}`);
  }

  try {
    await extension.deactivate();
    ok('deactivate() resolves', 'no wedged drain');
  } catch (error) {
    bad('deactivate() resolves', error.message);
  }

  // Nothing may have touched the real home.
  const realTouched = shown.filter((m) => m.includes(os.homedir()) && !m.includes(home));
  if (realTouched.length) bad('nothing addressed the real home', realTouched[0]);
  else ok('nothing addressed the real home', `sandbox ${home}`);

  report(results);
})().catch((error) => {
  console.error('harness threw:', error);
  process.exitCode = 3;
}).finally(() => {
  Module._load = originalLoad;
});

function report(results) {
  let fail = 0;
  for (const [verdict, name, detail] of results) {
    if (verdict === 'FAIL') fail += 1;
    console.log(`  ${verdict}  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
  console.log(`\ninstalled-artefact drive: ${results.length - fail} pass, ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
}
