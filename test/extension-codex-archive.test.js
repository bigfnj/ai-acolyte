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
