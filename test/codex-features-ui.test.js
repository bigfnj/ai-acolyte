'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { createCodexFeaturesUi, codexFeatureStatus } = require('../vscode-extension/codexFeaturesUi');
const { run } = require('../src/auto-learn-worker');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-features-ui-'));
  const codexHome = path.join(home, 'selected');
  const root = path.join(codexHome, 'memories');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'memory_summary.md'), 'v1\nNative summary.\n');
  fs.writeFileSync(path.join(root, 'MEMORY.md'), '# Task: galaxy registry\n\nNebulaprism uses the amber connection.\n');
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const seen = { dialogs: [], warnings: [], shown: [], opened: [], queries: [] };
  const vscode = {
    Uri: { file: (file) => ({ fsPath: file }) },
    Range: class { constructor(start, end) { this.start = start; this.end = end; } },
    workspace: { async openTextDocument(value) {
      seen.opened.push(value);
      const text = value.content ?? fs.readFileSync(value.fsPath, 'utf8');
      return { getText: () => text, positionAt: (offset) => offset };
    } },
    window: {
      async showInputBox() { return 'nebulaprism'; },
      async showQuickPick(items) { seen.items = items; return items[0]; },
      async showInformationMessage(...args) { seen.dialogs.push(args); return undefined; },
      showWarningMessage(message) { seen.warnings.push(message); },
      async showTextDocument(...args) { seen.shown.push(args); },
    },
  };
  const options = { home, codexHome };
  const ui = createCodexFeaturesUi(vscode, { profileOptions: options,
    readMemory: async (query) => { seen.queries.push(query); return run({ operation: 'codexMemory', options, args: [{ query }] }); } });
  return { home, codexHome, root, options, seen, vscode, ui };
}

test('native memory worker searches registry in selected profile without creating learner state', async (t) => {
  const f = fixture(t);
  const result = await new Promise((resolve, reject) => {
    const worker = new Worker(path.resolve(__dirname, '../src/auto-learn-worker.js'), {
      workerData: { operation: 'codexMemory', options: f.options, args: [{ query: 'nebulaprism' }] },
    });
    worker.on('message', resolve);
    worker.on('error', reject);
  });
  assert.equal(result.ok, true);
  assert.equal(result.result.chunks.length, 1);
  assert.equal(result.result.chunks[0].relativePath, 'MEMORY.md');
  assert.match(result.result.chunks[0].text, /amber connection/);
  assert.equal(fs.existsSync(path.join(f.home, '.claude')), false);
  assert.equal(fs.existsSync(path.join(f.home, '.codex')), false);
  assert.equal(codexFeatureStatus(f.options).files, 2);
  assert.equal(codexFeatureStatus(f.options).featureState, 'unknown');
});

test('memory search opens exact native source passage and reads edits afresh', async (t) => {
  const f = fixture(t);
  await f.ui.searchMemory();
  assert.deepEqual(f.seen.queries, ['nebulaprism']);
  assert.equal(f.seen.opened[0].fsPath, path.join(f.root, 'MEMORY.md'));
  const chunk = f.seen.items[0].chunk;
  assert.equal(f.seen.items[0].description, `MEMORY.md:${chunk.startLine}`);
  assert.equal(f.seen.shown[0][1].selection.start, chunk.startOffset);
  assert.equal(f.seen.shown[0][1].selection.end, chunk.endOffset);
  fs.writeFileSync(path.join(f.root, 'MEMORY.md'), '# Task: new registry\nNebulaprism now uses violet.\n');
  await f.ui.searchMemory();
  assert.match(f.seen.items[0].detail, /now uses violet/);
  assert.equal(f.seen.warnings.length, 0);
});

test('memory search refuses stale locations and reports incomplete sources', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'memory_summary.md'), Buffer.from([0xff]));
  f.vscode.window.showQuickPick = async (items) => {
    fs.writeFileSync(path.join(f.root, 'MEMORY.md'), 'Content moved.\n');
    return items[0];
  };
  await f.ui.searchMemory();
  assert.match(f.seen.warnings[0], /could not be read/);
  assert.match(f.seen.warnings[1], /changed after the search/);
  assert.equal(f.seen.shown.length, 0);
});

test('memory search maps explicit UTF-8 BOM provenance for first and later passages', async (t) => {
  const f = fixture(t);
  const text = '\uFEFF# Task: alpha\nNebulaprism uses amber.\n\n# Task: beta\nQuasarviolet uses indigo.\n';
  fs.writeFileSync(path.join(f.root, 'MEMORY.md'), text);
  f.vscode.workspace.openTextDocument = async (uri) => {
    const content = fs.readFileSync(uri.fsPath, 'utf8').replace(/^\uFEFF/, '');
    return { getText: () => content, positionAt: (offset) => offset };
  };
  await f.ui.searchMemory();
  assert.equal(f.seen.items[0].chunk.hasUtf8Bom, true);
  assert.equal(f.seen.items[0].chunk.startOffset, 0);
  assert.equal(f.seen.shown[0][1].selection.start, 0);
  assert.equal(f.seen.shown[0][1].selection.end, f.seen.items[0].chunk.endOffset - 1);
  f.vscode.window.showInputBox = async () => 'quasarviolet';
  await f.ui.searchMemory();
  const later = f.seen.items[0].chunk;
  assert.ok(later.startOffset > 0);
  assert.equal(f.seen.shown[1][1].selection.start, later.startOffset - 1);
  assert.equal(f.seen.shown[1][1].selection.end, later.endOffset - 1);
  assert.equal(f.seen.warnings.length, 0);
  assert.equal(fs.readFileSync(path.join(f.root, 'MEMORY.md'), 'utf8'), text);
});

test('memory inspection shows native diagnostics without a Claude line cap or enabling features', async (t) => {
  const f = fixture(t);
  fs.writeFileSync(path.join(f.root, 'memory_summary.md'), 'v0\n' + 'entry\n'.repeat(230) + 'rollout_summaries/gone.md\n');
  await f.ui.inspectMemory();
  const report = f.seen.opened[0].content;
  assert.match(report, /feature enablement: unknown/);
  assert.match(report, /^memory_summary\.md:1: Native memory_summary\.md does not start with the v1/m);
  assert.match(report, /^memory_summary\.md:232: Selected-memory reference is missing or unreadable: rollout_summaries\/gone\.md$/m,
    'a reference diagnostic names the editor line it is on, counted from 1');
  assert.match(report, /MEMORY.md/);
  assert.doesNotMatch(report, /200.line|over budget/);
  assert.equal(fs.existsSync(path.join(f.codexHome, 'config.toml')), false);
});

// Codex's consolidation job (src/codex-consolidation.js). The worker reads it beside the
// native files and merges its one warning; Inspect prints what the worker read.
let sqlite = null;
try { sqlite = require('node:sqlite'); } catch { sqlite = null; }
const SqliteDatabase = sqlite && (typeof sqlite.Database === 'function' ? sqlite.Database : sqlite.DatabaseSync);
const exactTier = typeof SqliteDatabase === 'function';
if (!exactTier) {
  process.stderr.write(`\n[codex-features-ui] SKIPPING the consolidation tier: node:sqlite is unavailable on ${process.version}.\n\n`);
}
function failingJob(codexHome) {
  const db = new SqliteDatabase(path.join(codexHome, 'memories_1.sqlite'));
  db.exec(`CREATE TABLE jobs (kind TEXT, job_key TEXT, status TEXT, worker_id TEXT, ownership_token TEXT,
    started_at INTEGER, finished_at INTEGER, lease_until INTEGER, retry_at INTEGER, retry_remaining INTEGER,
    last_error TEXT, input_watermark INTEGER, last_success_watermark INTEGER)`);
  db.prepare('INSERT INTO jobs (kind, job_key, status, finished_at, retry_at, retry_remaining, last_error) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('memory_consolidate_global', 'global', 'error', 1792999080, 1793002680, 2, 'failed_workspace_commit');
  db.close();
}

// MUTATION: return `memory.diagnostics` alone from the worker's codexMemory operation. The
// warning never reaches the lint, and this fails.
test('the native memory worker merges one consolidation warning beside the files\' own', { skip: !exactTier }, (t) => {
  const f = fixture(t);
  failingJob(f.codexHome);
  fs.writeFileSync(path.join(f.root, 'memory_summary.md'), 'v0\nNative summary.\n');
  f.options.run = () => { throw new Error('the git check spawned with no .git in the fixture'); };
  const report = run({ operation: 'codexMemory', options: f.options, args: [{}] });
  const warnings = report.diagnostics.filter((item) => item.code === 'consolidation-failed');
  assert.equal(warnings.length, 1);
  assert.equal(warnings[0].line, 0);
  assert.equal(warnings[0].path, report.files.find((file) => file.relativePath === 'MEMORY.md').path,
    'on the MEMORY.md the lint publishes, so it is a Problems entry');
  assert.ok(report.diagnostics.some((item) => item.code === 'summary-version'), 'the files\' own diagnostics are kept');
  assert.deepEqual(Object.keys(report.consolidation).sort(), ['probes', 'v1', 'v2']);
  assert.equal(report.consolidation.v1.status, 'error');
  assert.equal(report.chunks.length, 0, 'no query, no passages');
});

test('Inspect prints the consolidation job the worker read, and runs nothing', { skip: !exactTier }, async (t) => {
  const f = fixture(t);
  failingJob(f.codexHome);
  let spawned = 0;
  f.options.run = () => { spawned += 1; return { status: 0, stderr: '' }; };
  await f.ui.inspectMemory();
  const report = f.seen.opened[0].content;
  const lines = report.split('\n');
  const header = lines.indexOf('Codex memory consolidation (read-only: one row of the jobs table)');
  const fileLine = lines.findIndex((line) => /^MEMORY\.md: \d+ bytes, \d+ lines$/.test(line));
  assert.ok(fileLine > 0 && header > fileLine, 'the job follows the file list');
  assert.equal(lines[header - 1], '');
  assert.equal(lines[header + 1], 'v1 (memories): memories_1.sqlite, read');
  assert.match(report, /^ {2}status: error$/m);
  assert.match(report, /^ {2}last error: failed_workspace_commit$/m);
  assert.match(report, /^ {2}retries left: 2$/m);
  assert.match(report, /^ {2}finished: .+ \(2026-10-26T\d\d:\d\d:00\.000Z\)$/m);
  assert.match(report, /^MEMORY\.md:1: Codex memory consolidation is failing \(failed_workspace_commit\)/m);
  assert.equal(spawned, 0, 'no .git in the fixture, so the git check never ran');
  assert.deepEqual(fs.readdirSync(f.codexHome).sort(), ['memories', 'memories_1.sqlite'], 'the read created nothing');
});

test('Inspect says so when the Codex home has no consolidation database', async (t) => {
  const f = fixture(t);
  await f.ui.inspectMemory();
  const lines = f.seen.opened[0].content.split('\n');
  const header = lines.indexOf('Codex memory consolidation (read-only: one row of the jobs table)');
  assert.ok(header > 0);
  assert.equal(lines[header + 1], 'No memories_<n>.sqlite in this Codex home, so there is no consolidation job to read.');
});

test('hook UI reviews complete command, honors cancel, and configures only after chosen action', async (t) => {
  const f = fixture(t);
  const file = path.join(f.codexHome, 'hooks.json');
  await f.ui.configureHook();
  assert.equal(fs.existsSync(file), false);
  const [, modal, action] = f.seen.dialogs[0];
  assert.equal(modal.modal, true);
  assert.match(modal.detail, /codex-stop-hook\.js/);
  assert.match(modal.detail, /current Auto Learn mode/);
  assert.match(modal.detail, /review this exact hook in Codex \/hooks/);
  assert.equal(action, 'Configure hook');
  f.vscode.window.showInformationMessage = async (...args) => args[2];
  await f.ui.configureHook();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop.length, 1);
  await f.ui.configureHook();
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).hooks.Stop.length, 0);
});

test('hook confirmation after UI disposal cannot change configuration', async (t) => {
  const f = fixture(t);
  let answer;
  f.vscode.window.showInformationMessage = () => new Promise((resolve) => { answer = resolve; });
  const pending = f.ui.configureHook();
  f.ui.dispose();
  answer('Configure hook');
  await pending;
  assert.equal(fs.existsSync(path.join(f.codexHome, 'hooks.json')), false);
});

test('memory picker after UI disposal cannot open a source document', async (t) => {
  const f = fixture(t);
  let answer;
  let items;
  const shown = new Promise((resolve) => {
    f.vscode.window.showQuickPick = (choices) => {
      items = choices;
      resolve();
      return new Promise((done) => { answer = done; });
    };
  });
  const pending = f.ui.searchMemory();
  await shown;
  f.ui.dispose();
  answer(items[0]);
  await pending;
  assert.equal(f.seen.opened.length, 0);
});
