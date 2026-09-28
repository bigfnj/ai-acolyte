'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createCodexFeaturesUi } = require('../vscode-extension/codexFeaturesUi');

function fixture() {
  const text = '# Task: cooling\nThe engine overheated because its lubricant reservoir was empty.\n';
  const report = { root: '/selected/memories', storageState: 'readable',
    chunks: [{ path: '/selected/memories/MEMORY.md', relativePath: 'MEMORY.md', title: 'cooling',
      startLine: 1, startOffset: 0, endOffset: text.length, text }],
    retrieval: { mode: 'hybrid', rebuilt: true, indexedChunks: 4 } };
  const seen = { warnings: [], messages: [], picks: [], shown: [], refresh: 0, queries: [] };
  const vscode = { Uri: { file: (value) => value }, ProgressLocation: { Notification: 15 },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: { async openTextDocument() { return { getText: () => text, positionAt: (offset) => offset }; } },
    window: {
      async showInputBox() { return 'vehicle motor breakdown from missing lubrication'; },
      async showQuickPick(rows, options) { seen.picks.push({ rows, options }); return rows[0]; },
      showWarningMessage(message) { seen.warnings.push(message); },
      showInformationMessage(message) { seen.messages.push(message); },
      async showTextDocument(...args) { seen.shown.push(args); },
      async withProgress(options, callback) { seen.progress = options; return callback(); },
    } };
  const ui = createCodexFeaturesUi(vscode, { readMemory: async (query) => { seen.queries.push(query); return report; },
    rebuildMemory: async () => report, refresh: () => { seen.refresh++; } });
  return { report, seen, vscode, ui };
}

test('Codex semantic search exposes real hybrid mode while keeping exact passage selection', async () => {
  const f = fixture();
  await f.ui.searchMemory();
  assert.match(f.seen.picks[0].options.title, /meaning and keywords/);
  assert.deepEqual(f.seen.queries, ['vehicle motor breakdown from missing lubrication']);
  assert.equal(f.seen.shown[0][1].selection.end, f.report.chunks[0].endOffset);
  assert.equal(f.seen.warnings.length, 0);
});

test('Codex semantic fallback remains explicit on every search and preserves usable keyword matches', async () => {
  const f = fixture();
  f.report.retrieval = { mode: 'lexical', reason: 'CPU model unavailable' };
  await f.ui.searchMemory(); await f.ui.searchMemory();
  assert.equal(f.seen.warnings.length, 2, 'WITNESS fallback is reported on each degraded run');
  assert.ok(f.seen.warnings.every((message) => /keyword matches.*CPU model unavailable/.test(message)));
  assert.equal(f.seen.shown.length, 2);
  assert.ok(f.seen.picks.every((pick) => !pick.options.title.includes('meaning')), 'WITNESS lexical search never claims semantic retrieval');
});

test('Codex recall rebuild reports only confirmed saved semantic indexes and exposes cache failures', async () => {
  const f = fixture();
  await f.ui.rebuildMemoryIndex();
  assert.equal(f.seen.refresh, 1);
  assert.match(f.seen.messages[0], /indexed 4 Codex memory passages/);
  assert.equal(f.seen.progress.location, 15);
  f.report.retrieval.cacheWarning = 'write refused';
  await f.ui.rebuildMemoryIndex();
  assert.equal(f.seen.messages.length, 1, 'WITNESS failed persistence cannot claim a rebuilt index');
  assert.match(f.seen.warnings.at(-1), /write refused/);
  f.report.retrieval = { mode: 'lexical', rebuilt: false, reason: 'Python unavailable' };
  await f.ui.rebuildMemoryIndex();
  assert.equal(f.seen.messages.length, 1);
  assert.match(f.seen.warnings.at(-1), /Python unavailable/);
});

test('Codex recall rebuild resolved after disposal publishes no stale result', async () => {
  const f = fixture();
  let done;
  f.vscode.window.withProgress = () => new Promise((resolve) => { done = resolve; });
  const pending = f.ui.rebuildMemoryIndex();
  f.ui.dispose(); done(f.report); await pending;
  assert.equal(f.seen.messages.length, 0, 'WITNESS late CPU result is ignored after disposal');
  assert.equal(f.seen.refresh, 0);
});

test('semantic worker search and rebuild use selected profile and disclose unavailable runtime without learner state', async (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-recall-worker-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'selected');
  fs.mkdirSync(path.join(codexHome, 'memories'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'memories', 'MEMORY.md'), '# Task: galaxy\nNebulaprism uses amber.\n');
  for (const operation of ['codexMemorySearch', 'rebuildCodexMemory']) {
    const response = await new Promise((resolve, reject) => {
      const worker = new Worker(path.resolve(__dirname, '../src/auto-learn-worker.js'), { workerData: {
        operation, options: { home, codexHome }, args: [{ query: 'nebulaprism',
          recallOptions: { pythonExecutable: path.join(home, 'missing-python.exe') } }],
      } });
      worker.on('message', resolve); worker.on('error', reject);
    });
    assert.equal(response.ok, true);
    assert.equal(response.result.retrieval.mode, 'lexical');
    assert.match(response.result.retrieval.reason, /Python runtime is unavailable/);
    assert.equal(response.result.retrieval.rebuilt, false);
    if (operation === 'codexMemorySearch') assert.equal(response.result.chunks[0].relativePath, 'MEMORY.md');
  }
  assert.equal(fs.existsSync(path.join(home, '.claude')), false);
});
