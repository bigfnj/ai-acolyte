'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CodexMemoryLint } = require('../vscode-extension/codexMemoryLint');
const { readCodexMemory } = require('../src/codex-memory');

const flush = async () => { for (let index = 0; index < 5; index += 1) await Promise.resolve(); };
function deferred() { let resolve, reject; const promise = new Promise((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }

function harness(t, options = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-memory-lint-'));
  const codexHome = path.join(root, 'custom-codex');
  const memoryRoot = path.join(codexHome, 'memories');
  fs.mkdirSync(codexHome);
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] });
  const watchers = [];
  const reports = [];
  const reads = [];
  const entries = new Map();
  let enabled = true;
  let disposed = false;
  let creates = 0;
  let clearCount = 0;
  const collection = {
    set(uri, values) { assert.equal(disposed, false, 'disposed diagnostics must not be repopulated'); entries.set(uri.fsPath, values); },
    clear() { entries.clear(); clearCount += 1; },
    dispose() { disposed = true; },
  };
  const vscode = {
    RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
    Range: class { constructor(startLine, startCharacter, endLine, endCharacter) { Object.assign(this, { startLine, startCharacter, endLine, endCharacter }); } },
    Diagnostic: class { constructor(range, message, severity) { Object.assign(this, { range, message, severity }); } },
    DiagnosticSeverity: { Error: 0, Warning: 1, Information: 2, Hint: 3 },
    Uri: { file: (fsPath) => ({ scheme: 'file', fsPath }) },
    languages: { createDiagnosticCollection(name) { creates += 1; assert.equal(name, 'codex-memory'); return collection; } },
    workspace: { createFileSystemWatcher(pattern) {
      const callbacks = { create: new Set(), change: new Set(), delete: new Set() };
      const watcher = { pattern, disposed: false,
        dispose() { this.disposed = true; },
        fire(kind, target) { for (const callback of [...callbacks[kind]]) callback(typeof target === 'string' ? vscode.Uri.file(target) : target); },
      };
      for (const kind of ['create', 'change', 'delete']) {
        watcher['onDid' + kind[0].toUpperCase() + kind.slice(1)] = (callback) => {
          callbacks[kind].add(callback); return { dispose() { callbacks[kind].delete(callback); } };
        };
      }
      watchers.push(watcher); return watcher;
    } },
  };
  const worker = options.readMemory || (async ({ codexHome: selectedHome }) => readCodexMemory({ codexHome: selectedHome }));
  const lint = new CodexMemoryLint(vscode, { codexHome, enabled: () => enabled, debounceMs: 25, reconcileMs: 1000,
    readMemory: async (request) => { reads.push(request); return worker(request); },
    onRefresh: (report) => reports.push(report), ...options.constructorOptions });
  t.after(() => { lint.dispose(); fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); });
  function write(relative, text) {
    const file = path.join(memoryRoot, ...relative.split('/')); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file;
  }
  function descriptor(diagnostics = [], selectedHome = codexHome) {
    const selectedRoot = path.join(selectedHome, 'memories');
    return { agent: 'codex', codexHome: selectedHome, root: selectedRoot, featureState: 'unknown', storageState: 'readable', state: 'readable',
      files: [{ path: path.join(selectedRoot, 'MEMORY.md'), relativePath: 'MEMORY.md' }], diagnostics };
  }
  return { root, codexHome, memoryRoot, vscode, lint, watchers, reports, reads, entries, write, descriptor,
    setEnabled(value) { enabled = value; }, get creates() { return creates; }, get disposed() { return disposed; }, get clearCount() { return clearCount; },
    async tick(ms = 25) { t.mock.timers.tick(ms); await flush(); } };
}

test('Codex lint watches the selected home before memory exists and refreshes when the store is later created', async (t) => {
  const h = harness(t);
  assert.equal(h.lint.activate(), h.lint);
  await flush();
  assert.equal(h.reports.at(-1).storageState, 'absent');
  assert.equal(h.watchers[0].pattern.base, h.codexHome);
  assert.equal(h.watchers[0].pattern.pattern, 'memories{,/**}');
  assert.equal(h.watchers[1].pattern.base, path.dirname(h.codexHome));
  assert.deepEqual(h.reads, [{ codexHome: h.codexHome }]);
  const summary = h.write('memory_summary.md', 'invalid schema\n');
  h.watchers[0].fire('create', h.memoryRoot);
  h.watchers[0].fire('create', summary);
  await h.tick();
  assert.equal(h.reads.length, 2, 'creation burst must become one worker read');
  assert.equal(h.reports.at(-1).storageState, 'readable');
  assert.equal(h.entries.get(summary)[0].code, 'summary-version');
});

test('external selected-file changes and deletions replace diagnostics and refresh dashboard reports', async (t) => {
  const h = harness(t);
  const summary = h.write('memory_summary.md', 'invalid schema\n');
  h.lint.activate(); await flush();
  assert.equal(h.entries.size, 1);
  fs.writeFileSync(summary, 'v1\nrepaired\n');
  h.watchers[0].fire('change', summary); await h.tick();
  assert.equal(h.entries.size, 0, 'a fixed issue must clear');
  assert.equal(h.reports.at(-1).files.length, 1);
  fs.unlinkSync(summary);
  h.watchers[0].fire('delete', summary); await h.tick();
  assert.equal(h.reports.at(-1).files.length, 0, 'deletion must update card count');
  assert.equal(h.entries.size, 0);
  assert.equal(h.reads.length, 3);
});

test('Codex lint ignores raw, session, git, nested rollout and other-profile watcher noise', async (t) => {
  const h = harness(t);
  h.lint.activate(); await flush();
  for (const relative of ['raw_memories.md', '.git/index', 'sessions/rollout.jsonl', 'rollout_summaries/nested/a.md', 'skills/query/scripts/a.md', 'other.md']) {
    h.watchers[0].fire('change', path.join(h.memoryRoot, ...relative.split('/')));
  }
  h.watchers[0].fire('change', path.join(h.root, 'other-codex', 'memories', 'MEMORY.md'));
  h.watchers[0].fire('change', { scheme: 'untitled', fsPath: path.join(h.memoryRoot, 'MEMORY.md') });
  await h.tick();
  assert.equal(h.reads.length, 1, 'unselected files must not trigger a corpus read');
  for (const relative of ['MEMORY.md', 'memory_summary.md', 'rollout_summaries', 'rollout_summaries/a.md', 'skills', 'skills/query', 'skills/query/SKILL.md']) {
    h.watchers[0].fire('change', path.join(h.memoryRoot, ...relative.split('/'))); await h.tick();
  }
  assert.equal(h.reads.length, 8, 'each selected native shape must refresh');
});

test('Codex diagnostics preserve adapter severities and codes without inventing a Claude line cap', async (t) => {
  const h = harness(t);
  const registry = h.write('MEMORY.md', '# Registry\n' + 'fixture\n'.repeat(400));
  const summary = h.write('memory_summary.md', 'bad version\n');
  h.lint.activate(); await flush();
  assert.equal(h.entries.has(registry), false, 'long Codex registry is not a Claude index-cap problem');
  const diagnostic = h.entries.get(summary)[0];
  assert.equal(diagnostic.severity, h.vscode.DiagnosticSeverity.Warning);
  assert.equal(diagnostic.range.startLine, 0);
  assert.equal(diagnostic.source, 'Codex native memory');
  assert.equal(diagnostic.code, 'summary-version');
  h.lint.readMemory = async () => h.descriptor([{ path: registry, code: 'file-unreadable', severity: 'error', message: 'Synthetic unreadable source' }]);
  await h.lint.refresh();
  assert.equal(h.entries.get(registry)[0].severity, h.vscode.DiagnosticSeverity.Error);
  assert.equal(h.entries.get(registry)[0].message, 'Synthetic unreadable source');
  assert.equal(h.entries.has(summary), false, 'publish must replace all prior Problems');
});

test('root and directory read failures stay visible in reports without creating fake file Problems', async (t) => {
  const h = harness(t);
  h.lint.readMemory = async () => ({ ...h.descriptor(), storageState: 'unreadable', state: 'unreadable', files: [],
    diagnostics: [{ path: h.memoryRoot, code: 'root-unreadable', severity: 'error', message: 'Synthetic EACCES' }] });
  h.lint.activate(); await flush();
  assert.equal(h.entries.size, 0);
  assert.equal(h.reports.at(-1).storageState, 'unreadable');
  assert.equal(h.reports.at(-1).diagnostics[0].message, 'Synthetic EACCES');
});

test('worker transport failures clear stale Problems and explicitly report unavailable memory', async (t) => {
  const h = harness(t);
  h.write('memory_summary.md', 'bad schema\n');
  h.lint.activate(); await flush();
  assert.equal(h.entries.size, 1);
  h.lint.readMemory = async () => { throw new Error('synthetic worker stopped'); };
  const report = await h.lint.refresh();
  assert.equal(h.entries.size, 0);
  assert.equal(report.storageState, 'unreadable');
  assert.match(report.error, /synthetic worker stopped/);
  assert.equal(h.reports.at(-1), report);
  assert.deepEqual(report.diagnostics, [], 'transport failure is not a fabricated file lint');
});

test('disabling and re-enabling Codex lint clears diagnostics, changes watchers and starts a fresh worker read', async (t) => {
  const h = harness(t);
  h.write('memory_summary.md', 'bad schema\n');
  h.lint.activate(); await flush();
  const old = [...h.watchers];
  h.setEnabled(false); h.lint.reconfigure();
  assert.equal(h.entries.size, 0);
  assert.equal(h.lint.lastReport, null);
  assert.equal(h.reports.at(-1), null);
  assert.ok(old.every((watcher) => watcher.disposed));
  const before = h.reads.length;
  for (const watcher of old) watcher.fire('change', path.join(h.memoryRoot, 'MEMORY.md'));
  await h.tick();
  assert.equal(h.reads.length, before);
  h.setEnabled(true); h.lint.reconfigure(); await flush();
  assert.equal(h.reads.length, before + 1);
  assert.equal(h.entries.size, 1);
  assert.equal(h.creates, 1, 'diagnostic collection is created once');
});

test('initially disabled Codex lint performs no worker read and keeps no file watchers', async (t) => {
  const h = harness(t);
  h.setEnabled(false); h.lint.activate(); await flush();
  assert.deepEqual(h.reads, []);
  assert.deepEqual(h.watchers, []);
  assert.equal(h.entries.size, 0);
  assert.equal(h.lint.activate(), h.lint);
  assert.equal(h.creates, 1);
});

test('older asynchronous memory results cannot overwrite a newer report or diagnostics', async (t) => {
  const first = deferred(); const second = deferred();
  let calls = 0;
  const h = harness(t, { readMemory: () => (++calls === 1 ? first.promise : second.promise) });
  h.lint.activate();
  const refreshed = h.lint.refresh();
  const newer = h.descriptor();
  second.resolve(newer); await refreshed;
  first.resolve(h.descriptor([{ path: newer.files[0].path, code: 'old', severity: 'warning', message: 'Stale diagnostic' }]));
  await flush();
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0], newer);
  assert.equal(h.entries.size, 0);
});

test('a selected file event invalidates in-flight results before the debounce expires', async (t) => {
  const first = deferred();
  const h = harness(t, { readMemory: () => first.promise });
  h.lint.activate();
  h.watchers[0].fire('change', path.join(h.memoryRoot, 'MEMORY.md'));
  first.resolve(h.descriptor()); await flush();
  assert.equal(h.reports.length, 0, 'changed content must not publish a known-stale read during debounce');
  h.lint.readMemory = async () => h.descriptor();
  await h.tick();
  assert.equal(h.reports.length, 1);
});

test('reconfiguring Codex home rejects old in-flight profile results and watches the new home', async (t) => {
  const first = deferred();
  const h = harness(t, { readMemory: () => first.promise });
  h.lint.activate();
  const newerHome = path.join(h.root, 'second-codex');
  h.lint.readMemory = async () => h.descriptor([], newerHome);
  h.lint.reconfigure({ codexHome: newerHome }); await flush();
  first.resolve(h.descriptor()); await flush();
  assert.equal(h.reports.length, 1);
  assert.equal(h.reports[0].codexHome, newerHome);
  assert.equal(h.watchers.at(-2).pattern.base, newerHome);
  assert.equal(h.watchers[0].disposed, true);
});

test('a mismatched worker profile is reported as unavailable without publishing another profile diagnostics', async (t) => {
  const h = harness(t);
  h.lint.readMemory = async () => h.descriptor([], path.join(h.root, 'other'));
  h.lint.activate(); await flush();
  assert.equal(h.entries.size, 0);
  assert.equal(h.reports.at(-1).root, h.memoryRoot);
  assert.equal(h.reports.at(-1).storageState, 'unreadable');
  assert.match(h.reports.at(-1).error, /different Codex profile/);
});

test('outside-root diagnostics and non-source directory paths never become file Problems', async (t) => {
  const h = harness(t);
  const outside = path.join(h.root, 'private.md');
  const report = h.descriptor([{ path: outside, message: 'Wrong profile', code: 'outside', severity: 'error' },
    { path: path.join(h.memoryRoot, 'rollout_summaries'), message: 'Directory read failed', code: 'directory-unreadable', severity: 'error' }]);
  report.files.push({ path: outside });
  h.lint.readMemory = async () => report;
  h.lint.activate(); await flush();
  assert.equal(h.entries.size, 0);
  assert.equal(h.reports.at(-1).diagnostics.length, 2, 'report retains adapter failures for inspection');
});

test('home recreation and periodic reconciliation renew subscriptions and rediscover memory', async (t) => {
  const h = harness(t);
  h.lint.activate(); await flush();
  const parent = h.watchers[1];
  parent.fire('create', h.codexHome); await flush();
  assert.equal(parent.disposed, true);
  assert.equal(h.reads.length, 2);
  await h.tick(1000);
  assert.equal(h.reads.length, 3, 'backstop refresh covers events missed when selected roots moved');
  assert.equal(h.watchers.length, 6);
  assert.ok(h.watchers.slice(0, 4).every((watcher) => watcher.disposed));
});

test('watcher failures stay explicit on every successful worker refresh', async (t) => {
  const h = harness(t);
  h.vscode.workspace.createFileSystemWatcher = () => { throw new Error('synthetic watcher refused'); };
  h.lint.activate(); await flush();
  assert.equal(h.entries.size, 0);
  assert.match(h.reports.at(-1).watchError, /synthetic watcher refused/);
  await h.lint.refresh();
  assert.match(h.reports.at(-1).watchError, /synthetic watcher refused/);
});

test('dispose cancels debounce, watchers and reconcile timer and ignores late worker results', async (t) => {
  const pending = deferred();
  const h = harness(t, { readMemory: () => pending.promise });
  h.lint.activate();
  h.watchers[0].fire('change', path.join(h.memoryRoot, 'MEMORY.md'));
  h.lint.dispose();
  pending.resolve(h.descriptor()); await flush(); await h.tick(2000);
  assert.equal(h.reports.length, 0);
  assert.equal(h.reads.length, 1);
  assert.equal(h.entries.size, 0);
  assert.equal(h.disposed, true);
  assert.ok(h.watchers.every((watcher) => watcher.disposed));
  assert.equal(h.lint.lastReport, null);
  assert.equal(await h.lint.refresh(), null);
  h.lint.reconfigure(); h.lint.activate();
  assert.equal(h.reads.length, 1);
});

test('late worker failure after disabling cannot reintroduce a report or Problems', async (t) => {
  const pending = deferred();
  const h = harness(t, { readMemory: () => pending.promise });
  h.lint.activate(); h.setEnabled(false); h.lint.reconfigure();
  pending.reject(new Error('late synthetic failure')); await flush();
  assert.deepEqual(h.reports, [null]);
  assert.equal(h.entries.size, 0);
  assert.equal(h.lint.lastReport, null);
});

test('malformed worker metadata is visible as unavailable rather than an unhandled publish error', async (t) => {
  const h = harness(t);
  h.lint.readMemory = async () => ({ ...h.descriptor(), files: [null] });
  h.lint.activate(); await flush();
  assert.equal(h.reports.at(-1).storageState, 'unreadable');
  assert.match(h.reports.at(-1).error, /invalid native-memory source metadata/);
  assert.equal(h.entries.size, 0);
});
