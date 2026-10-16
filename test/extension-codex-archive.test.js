'use strict';

// THE EXTENSION READS ARCHIVED CODEX THREADS, WATCHES WHERE THEY GO, AND SAYS
// WHY A SCAN IS DEGRADED.
//
// MEASURED 2026-10-13 on the development box: archiving a Codex thread moves its
// rollout into `~/.codex/archived_sessions/`. The manager's default roots now
// cover that folder, but the extension passed `paths.codexHistory:
// CODEX_SESSIONS_DIR`, which overrode the default with `sessions/` alone -- so
// the one host most users run would have kept dropping archived threads however
// the manager was fixed. This drives the real extension through the real scan
// command, worker included, and reads what it wrote.
//
// It also pins the output channel. The panel has room for a phrase; the reason
// behind "scan degraded" had nowhere to go, so a user could not find out what
// to do about it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Module = require('node:module');

const THREAD = '0192aaaa-1111-7000-8000-00000000ac01';
const MISSING = '0192aaaa-1111-7000-8000-00000000ac02';

test('a real scan reads the archive, watches it, and logs each Codex reason once', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-ext-archive-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  const workspaceRoot = path.join(home, 'repo');
  fs.mkdirSync(workspaceRoot, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    `${JSON.stringify({ permissions: { allow: [] } }, null, 2)}\n`);
  const codex = path.join(home, '.codex');
  const archive = path.join(codex, 'archived_sessions');
  fs.mkdirSync(path.join(codex, 'sessions'), { recursive: true });
  fs.mkdirSync(archive, { recursive: true });
  const records = [{ type: 'session_meta', payload: { id: THREAD, cwd: workspaceRoot } }];
  for (const id of ['a', 'b']) {
    records.push({ type: 'response_item', payload: {
      type: 'function_call', name: 'shell_command', call_id: id,
      arguments: JSON.stringify({ command: 'git status --short', workdir: workspaceRoot }),
    } });
    records.push({ type: 'response_item', payload: {
      type: 'function_call_output', call_id: id, output: JSON.stringify({ exit_code: 0, output: 'ok' }),
    } });
  }
  fs.writeFileSync(path.join(archive, `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`),
    `${records.map((record) => JSON.stringify(record)).join('\n')}\n`);
  // One thread the index names and no folder holds: a real divergence, so the
  // scan has a reason to log.
  fs.writeFileSync(path.join(codex, 'session_index.jsonl'),
    `${[THREAD, MISSING].map((id) => JSON.stringify({ id, thread_name: 'fixture' })).join('\n')}\n`);

  const disposable = () => ({ dispose() {} });
  const commands = new Map();
  const watchers = [];
  const channels = [];
  const vscode = {
    ExtensionMode: { Test: 3 },
    StatusBarAlignment: { Left: 1, Right: 2 },
    ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    ProgressLocation: { Notification: 15 },
    RelativePattern: class RelativePattern {
      constructor(base, pattern) { this.base = base; this.pattern = pattern; }
    },
    ThemeColor: class ThemeColor { constructor(id) { this.id = id; } },
    EventEmitter: class { constructor() { this.event = () => disposable(); } fire() {} dispose() {} },
    Uri: { file: (p) => ({ fsPath: p }) },
    commands: {
      registerCommand(id, handler) { commands.set(id, handler); return disposable(); },
      executeCommand() { return Promise.resolve(); },
    },
    window: {
      createOutputChannel(name) {
        const channel = { name, lines: [], appendLine(line) { this.lines.push(line); },
          append() {}, show() {}, clear() { this.lines.length = 0; }, dispose() {} };
        channels.push(channel);
        return channel;
      },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {}, text: '', tooltip: '' }; },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage() {},
      showErrorMessage() {},
      showInformationMessage() { return Promise.resolve(undefined); },
      showWarningMessage() {},
      showQuickPick() { return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true,
      workspaceFolders: [{ uri: { fsPath: workspaceRoot } }],
      createFileSystemWatcher(pattern) {
        watchers.push(pattern);
        return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} };
      },
      getConfiguration() {
        return { get: (key, fallback) => fallback, inspect: () => ({}), update: async () => {} };
      },
      onDidChangeConfiguration() { return disposable(); },
      onDidChangeWorkspaceFolders() { return disposable(); },
    },
  };

  const extensionPath = require.resolve('../vscode-extension/extension');
  const rootSrc = path.resolve(__dirname, '..', 'src');
  const originalLoad = Module._load;
  const originalHomeEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((key) => [key, process.env[key]]));
  Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: codex });
  Module._load = function load(request, parent, isMain) {
    if (request === 'vscode') return vscode;
    if (request === 'os') return { ...os, homedir: () => home };
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

  const logged = () => channels.flatMap((channel) => channel.lines).filter((line) => line.includes('Auto Learn scan:'));
  let extension;
  let first;
  let second;
  try {
    delete require.cache[extensionPath];
    extension = require(extensionPath);
    extension.activate({ subscriptions: [] });
    assert.ok(watchers.some((pattern) => pattern.pattern === 'archived_sessions/*.jsonl'
      && path.resolve(pattern.base.fsPath) === path.resolve(codex)),
    `witness:archive-watcher -- nothing watches the folder archiving moves rollouts into: ${
      JSON.stringify(watchers.map((pattern) => pattern.pattern))}`);
    // Codex compresses idle rollouts in place (2026-10-16), and archives the
    // compressed ones: in both folders, a move then touches only the .zst.
    for (const glob of ['sessions/**/*.jsonl.zst', 'archived_sessions/*.jsonl.zst']) {
      assert.ok(watchers.some((pattern) => pattern.pattern === glob
        && path.resolve(pattern.base.fsPath) === path.resolve(codex)),
      `witness:compressed-watcher -- nothing watches ${glob}: ${JSON.stringify(watchers.map((pattern) => pattern.pattern))}`);
    }

    await commands.get('permission-wildcarding.autoLearnScan')();
    first = logged().slice();
    // The same condition, scanned again. A scan runs every few minutes and on
    // every transcript write, so a reason that persists must not be re-logged.
    await commands.get('permission-wildcarding.autoLearnScan')();
    second = logged().slice();
  } finally {
    try { await extension?.deactivate?.(); } catch { /* teardown only */ }
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalHomeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    delete require.cache[extensionPath];
  }

  // The pin is gone: the archived thread's calls are evidence.
  const { createAutoLearnManager } = require('../src/auto-learn-manager');
  const manager = createAutoLearnManager({ home, codexHome: codex, workspaceRoot });
  const candidate = manager.listCandidates().find((item) => item.sources.includes('codex'));
  assert.ok(candidate,
    'witness:extension-codex-roots -- the extension scan did not read archived_sessions, so its '
    + 'Codex root is still pinned to sessions/');
  assert.equal(candidate.counts.success, 2);
  assert.equal(manager.status().lastScanStats.codexHistoryStale, true, 'precondition: the fixture diverges');

  // One line for the reason, naming folders and never the path to them.
  assert.ok(first.some((line) => /Codex history: 1 Codex thread\(s\) exist .*no rollout file in sessions\/, archived_sessions\//.test(line)),
    `witness:scan-log -- the reason never reached the output channel: ${JSON.stringify(first)}`);
  assert.ok(first.every((line) => !line.includes(home)), 'a logged reason carried a full path');
  assert.deepEqual(second, first,
    'witness:scan-log-dedupe -- an unchanged condition was logged again on the next scan');
});

// THE DEDUPE IS OVER KINDS OF TROUBLE, NOT OVER TEXT (2026-10-14). The signature was
// the joined lines, counts and all, so a corpus whose unreadable-file count moved
// between scans appended a line per scan, which is the flood the dedupe exists to
// stop. And the history NOTES (migrations, archived threads with no transcript, a
// skipped cross-check) were computed by every scan and shown only in the CLI's
// JSON. A scripted worker drives the real logScanTrouble through the scan command.
test('scan trouble is logged when its kinds change, not when a count moves, and history notes are logged as notes', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-ext-trouble-'));
  t.after(() => { try { fs.rmSync(home, { recursive: true, force: true }); } catch {} });
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: [] } }));
  // The fourth scan is a REAL manager's (2026-10-14, F3 of the v1.6.3 confirmation audit): a
  // configured Codex root that is missing holds the evidence rebuild open, and the reason it now
  // gives must reach this channel as trouble, like every Codex reason, by folder name only.
  const heldHome = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-ext-held-'));
  t.after(() => { try { fs.rmSync(heldHome, { recursive: true, force: true }); } catch {} });
  const heldState = path.join(heldHome, '.claude', 'wildcarding', 'auto-learn-state.json');
  fs.mkdirSync(path.dirname(heldState), { recursive: true });
  fs.writeFileSync(heldState, JSON.stringify({ version: 3, codexEvidenceRevision: 4, codexEvidenceRebuildPending: true,
    codexEvidencePendingFiles: [`path-sha256:${'b'.repeat(24)}`], candidates: {}, cursors: {} }));
  const held = require('../src/auto-learn-manager').createAutoLearnManager({
    home: heldHome, statePath: heldState,
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }),
    historyScanner: () => ({ observations: [], cursors: {},
      files: [{ source: 'codex', mode: 'full', path: path.join(heldHome, '.codex', 'archived_sessions', 'other.jsonl') }],
      missingRoots: [{ path: path.join(heldHome, '.codex', 'sessions'), source: 'codex', link: false }] }),
  }).scan();
  assert.equal(held.codexEvidence.pending, true, 'precondition: the missing root holds the rebuild');
  const results = [
    { errors: 3, codexHistoryNotes: ['2 entries in rollout-migrations/: Codex has recorded a rollout migration.'] },
    { errors: 4, codexHistoryNotes: ['3 entries in rollout-migrations/: Codex has recorded a rollout migration.'] },
    { errors: 4, unreadable: 1, codexHistoryNotes: ['3 entries in rollout-migrations/: Codex has recorded a rollout migration.'] },
    held,
  ];
  const disposable = () => ({ dispose() {} });
  const commands = new Map();
  const channels = [];
  const vscode = {
    StatusBarAlignment: { Left: 1, Right: 2 }, ConfigurationTarget: { Global: 1, Workspace: 2, WorkspaceFolder: 3 },
    RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    ThemeColor: class ThemeColor {}, Uri: { file: (p) => ({ fsPath: p }) },
    commands: { registerCommand(id, handler) { commands.set(id, handler); return disposable(); }, executeCommand() {} },
    window: {
      createOutputChannel(name) {
        const channel = { name, lines: [], appendLine(line) { this.lines.push(line); }, append() {}, show() {},
          clear() { this.lines.length = 0; }, dispose() {} };
        channels.push(channel);
        return channel;
      },
      createStatusBarItem() { return { show() {}, hide() {}, dispose() {} }; },
      registerWebviewViewProvider() { return disposable(); },
      setStatusBarMessage() {}, showErrorMessage() {}, showWarningMessage() {},
      showInformationMessage() { return Promise.resolve(undefined); },
    },
    workspace: {
      isTrusted: true, workspaceFolders: [{ uri: { fsPath: home } }],
      createFileSystemWatcher() { return { onDidChange() {}, onDidCreate() {}, onDidDelete() {}, dispose() {} }; },
      getConfiguration() { return { get: (key, fallback) => (key === 'autoLearn.enabled' ? false : fallback), inspect: () => ({}), update: async () => {} }; },
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
        async run(operation) { return operation === 'scan' ? results.shift() : {}; },
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
  const logged = () => channels.flatMap((channel) => channel.lines).map((line) => line.replace(/^\[[^\]]*\] /, ''));
  let extension;
  const after = [];
  try {
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(path.dirname(extensionPath) + path.sep)) delete require.cache[key];
    }
    extension = require(extensionPath);
    extension.activate({ subscriptions: [] });
    for (let scan = 0; scan < 4; scan += 1) {
      await commands.get('permission-wildcarding.autoLearnScan')();
      after.push(logged().slice());
    }
  } finally {
    try { await extension?.deactivate?.(); } catch { /* teardown only */ }
    Module._load = originalLoad;
    for (const [key, value] of Object.entries(originalHomeEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    for (const key of Object.keys(require.cache)) {
      if (key.startsWith(rootSrc + path.sep) || key.startsWith(path.dirname(extensionPath) + path.sep)) delete require.cache[key];
    }
  }

  assert.deepEqual(after[0], [
    'Auto Learn scan: 3 files could not be read',
    'Auto Learn scan note: Codex history: 2 entries in rollout-migrations/: Codex has recorded a rollout migration.',
  ], 'witness:scan-notes -- the first scan logs its trouble and, labelled apart, its history note');
  // MUTATION: build the signature from the line text again (counts included). The
  // second scan's "4 files" and "3 entries" are a new set and two lines are appended.
  // Confirmed 2026-10-14.
  assert.deepEqual(after[1], after[0], 'witness:scan-kinds -- a moved count re-logged a condition that persists');
  // MUTATION: drop the codexHistoryNotes loop. The note line is never logged and the
  // first assertion fails. Confirmed 2026-10-14.
  assert.deepEqual(after[2].slice(after[1].length), [
    'Auto Learn scan: 4 files could not be read',
    'Auto Learn scan: 1 file had an unreadable stretch that was skipped',
    'Auto Learn scan note: Codex history: 3 entries in rollout-migrations/: Codex has recorded a rollout migration.',
  ], 'a new KIND of trouble logs the whole current set, with the current counts');
  // MUTATION: drop the `rebuildHeldOpen ? [...] :` from the manager's lastScanStats. The real scan
  // logs nothing and this fails. Confirmed 2026-10-14.
  const heldLines = after[3].slice(after[2].length);
  assert.equal(heldLines.length, 1, JSON.stringify(heldLines));
  assert.match(heldLines[0],
    /^Auto Learn scan: Codex history: The Codex evidence rebuild is held open: the configured history folder sessions\/ is missing/);
  assert.ok(!heldLines[0].includes(heldHome), `a path reached the channel: ${heldLines[0]}`);
});
