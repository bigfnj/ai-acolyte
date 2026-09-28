'use strict';

// Actual editor UI and worker CPU retrieval over owned synthetic native memory.
// The companion renderer chooses visible controls; no VS Code APIs are mocked.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

exports.run = async function run() {
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_RECALL_ONLY, '1');
  const home = process.env.ACOLYTE_ACCEPTANCE_HOME;
  const codexHome = process.env.ACOLYTE_ACCEPTANCE_CODEX_HOME;
  const extensionDir = process.env.ACOLYTE_ACCEPTANCE_EXTENSION;
  const reportPath = process.env.ACOLYTE_ACCEPTANCE_REPORT;
  const root = path.dirname(reportPath);
  const progress = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const normalized = (value) => path.resolve(value).toLowerCase();
  const results = [];
  const recall = { steps: [], selections: [], boundary: 'Actual editor dashboard, ranked native-memory picker and source selections; actual CPU retrieval through the worker, synthetic isolated memory passages and private cache. No GPU, generation, downloads or live profile access.' };
  const originalModelDir = process.env.RECALL_MODEL_DIR;
  const writeProgress = (phase, details = {}) => {
    assert.equal(normalized(path.dirname(progress)), normalized(root));
    fs.writeFileSync(progress + '.tmp', JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(progress + '.tmp', progress);
  };
  const waitFor = async (predicate, label, timeout = 30000) => {
    const deadline = Date.now() + timeout;
    do { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
    while (Date.now() < deadline);
    throw new Error('timed out waiting for ' + label);
  };
  const check = async (name, body) => {
    try { results.push({ verdict: 'PASS', name, detail: await body() || '' }); }
    catch (error) { results.push({ verdict: 'FAIL', name, detail: error.stack || error.message }); }
  };
  const failed = () => results.some((item) => item.verdict === 'FAIL');
  const action = async (caseId, details) => {
    const ackPath = path.join(root, `codex-recall-${caseId}.json`);
    assert.equal(fs.existsSync(ackPath), false);
    writeProgress('codex-recall-action', { caseId, ...details, ackPath });
    const ack = await waitFor(() => fs.existsSync(ackPath) && JSON.parse(fs.readFileSync(ackPath, 'utf8')), caseId + ' actual UI acknowledgment', 60000);
    assert.equal(ack.caseId, caseId); assert.equal(ack.status, 'passed', ack.error || ack.detail || 'see renderer report');
    recall.steps.push(ack); return ack;
  };
  const snapshot = () => {
    const values = {};
    const walk = (file) => {
      if (!fs.existsSync(file)) return;
      for (const entry of fs.readdirSync(file, { withFileTypes: true })) {
        const full = path.join(file, entry.name);
        if (entry.isDirectory()) walk(full);
        else { assert.ok(entry.isFile()); values[full] = hash(fs.readFileSync(full)); }
      }
    };
    walk(codexHome); walk(path.join(home, '.claude')); walk(path.join(home, '.ai-acolyte'));
    delete values[recall.cachePath]; return values;
  };
  const memory = path.join(codexHome, 'memories');
  const fixtures = [
    { id: 'registry', relative: 'MEMORY.md', title: 'Task: Languages', text: '# Task: Languages\nWriting code in dot net is really fun.\n', query: 'software development enjoyment', bom: true },
    { id: 'rollout', relative: 'rollout_summaries/vehicle.md', title: 'Mechanical repair', text: '# Mechanical repair\nThe automobile engine failed because the oil reservoir was empty.\n', query: 'vehicle motor breakdown from missing lubrication' },
    { id: 'skill', relative: 'skills/snapshot/SKILL.md', title: 'Disk retrieval', text: '# Disk retrieval\nWhen the internet connection is unavailable, use the disk snapshot to retrieve documents.\n', query: 'offline access cached files' },
  ];
  const select = async (entry, caseId, mode, query = entry.query) => {
    const file = path.join(memory, entry.relative);
    // An empty current selection prevents a prior successful route masking no-op.
    const document = await vscode.workspace.openTextDocument(vscode.Uri.file(file));
    const editor = await vscode.window.showTextDocument(document, { preview: true });
    editor.selection = new vscode.Selection(0, 0, 0, 0);
    const ack = await action(caseId, { kind: 'search', mode, query, expectedPath: file,
      expectedLabel: entry.title, expectedDescription: `${entry.relative}:1`, expectedText: entry.text,
      ...(mode === 'lexical' ? { expectedWarning: 'AI Acolyte: Codex memory search is using keyword matches. The existing bge-small CPU model and vocabulary are unavailable. No download was attempted.' } : {}) });
    assert.equal(ack.clicked, 'searchCodexMemory'); assert.equal(ack.selectedIndex, 0);
    const active = await waitFor(() => normalized(vscode.window.activeTextEditor?.document.uri.fsPath || root) === normalized(file) ? vscode.window.activeTextEditor : null, 'selected native source editor');
    assert.equal(active.document.getText(active.selection), entry.text, 'WITNESS actual ' + caseId + ' selects the exact decoded native passage');
    recall.selections.push({ caseId, path: file, selectedText: active.document.getText(active.selection),
      start: { line: active.selection.start.line, character: active.selection.start.character },
      end: { line: active.selection.end.line, character: active.selection.end.character } });
  };
  try {
    await check('selected extension activates with existing CPU assets and isolated native memory', async () => {
      const extension = vscode.extensions.getExtension('local.permission-wildcarding');
      assert.ok(extension); assert.equal(normalized(extension.extensionPath), normalized(extensionDir));
      await extension.activate(); assert.ok(extension.isActive);
      assert.equal(vscode.workspace.getConfiguration('permissionWildcarding').get('autoLearn.enabled'), false);
      for (const name of ['bge-small.onnx', 'bge-small.vocab.txt']) assert.ok(fs.existsSync(path.join(originalModelDir, name)));
      assert.ok(fs.existsSync(process.env.TOOLBOX_PYTHON));
      assert.equal(fs.existsSync(memory), false);
      fs.mkdirSync(memory, { recursive: true });
      for (const entry of fixtures) {
        const file = path.join(memory, entry.relative); fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, entry.bom ? Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(entry.text)]) : entry.text);
      }
      fs.writeFileSync(path.join(memory, 'memory_summary.md'), 'v1\nThe weather outside is freezing cold today.\n');
      fs.writeFileSync(path.join(memory, 'raw_memories.md'), 'PRIVATE_RAW_SENTINEL software development enjoyment vehicle motor breakdown offline access cached files');
      const { readCodexMemory, queryCodexMemory } = require(path.join(extensionDir, 'src/codex-memory'));
      const corpus = readCodexMemory({ home, codexHome });
      for (const entry of fixtures) assert.equal(queryCodexMemory(corpus, entry.query).length, 0, 'fixture paraphrase must have zero keyword matches');
      assert.equal(corpus.chunks.length, 4);
      assert.ok(corpus.chunks.find((item) => item.relativePath === 'MEMORY.md').hasUtf8Bom);
      recall.profileId = hash(normalized(codexHome));
      recall.cachePath = path.join(home, '.ai-acolyte', 'codex', recall.profileId, 'recall', 'index.json');
      assert.equal(fs.existsSync(recall.cachePath), false);
      recall.assets = { python: process.env.TOOLBOX_PYTHON, modelPath: path.join(originalModelDir, 'bge-small.onnx'),
        modelSha: hash(fs.readFileSync(path.join(originalModelDir, 'bge-small.onnx'))) };
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
      return `VS Code ${vscode.version}; host ${process.version}; four selected native passages, raw memory excluded; existing CPU model ${recall.assets.modelSha}.`;
    });
    if (failed()) return;
    await check('actual semantic search ranks and selects zero-keyword registry, rollout and skill passages', async () => {
      const before = snapshot();
      for (const entry of fixtures) await select(entry, 'search-' + entry.id, 'hybrid');
      const cache = JSON.parse(fs.readFileSync(recall.cachePath, 'utf8'));
      assert.equal(cache.identity.profileId, recall.profileId); assert.equal(cache.identity.modelSha, recall.assets.modelSha);
      assert.equal(Object.keys(cache.windows).length, 4);
      assert.ok(Object.values(cache.windows).every((item) => item.vector.length === 384 && item.vector.some((number) => number !== 0)));
      assert.equal(fs.readFileSync(recall.cachePath, 'utf8').includes('PRIVATE_RAW_SENTINEL'), false);
      assert.deepEqual(snapshot(), before, 'semantic search must preserve native sources, instructions and learner state');
      recall.initialCache = cache;
      return 'Actual hybrid picker ranks each zero-keyword paraphrase first, then exact native source ranges are selected, including the decoded BOM registry; private CPU vectors appear only in the owned cache.';
    });
    if (failed()) return;
    await check('actual Rebuild ignores cached vectors and restores the private semantic index', async () => {
      const original = JSON.parse(fs.readFileSync(recall.cachePath, 'utf8'));
      const poisoned = structuredClone(original);
      for (const value of Object.values(poisoned.windows)) value.vector.fill(0);
      fs.writeFileSync(recall.cachePath, JSON.stringify(poisoned));
      const beforeStat = fs.statSync(recall.cachePath); const before = snapshot();
      const ack = await action('rebuild', { kind: 'rebuild', expectedCount: 4,
        expectedNotification: 'AI Acolyte: indexed 4 Codex memory passages for search by meaning and keywords.' });
      assert.equal(ack.clicked, 'rebuildCodexMemory');
      const rebuilt = await waitFor(() => {
        const value = JSON.parse(fs.readFileSync(recall.cachePath, 'utf8'));
        return Object.values(value.windows).every((item) => item.vector.some((number) => number !== 0)) ? value : null;
      }, 'WITNESS actual Rebuild replaces valid-shape cached vectors');
      assert.deepEqual(rebuilt, original, 'CPU rebuild must restore every original vector and identity');
      assert.ok(fs.statSync(recall.cachePath).mtimeMs > beforeStat.mtimeMs);
      assert.deepEqual(snapshot(), before);
      recall.rebuild = { restoredWindows: Object.keys(rebuilt.windows).length, beforeMtimeMs: beforeStat.mtimeMs,
        afterMtimeMs: fs.statSync(recall.cachePath).mtimeMs };
      return 'Actual Rebuild button restores all four deliberately zeroed, valid-shape cache vectors and reports the actual indexed passage count; native files remain byte-identical.';
    });
    if (failed()) return;
    await check('missing semantic assets visibly fall back to usable keyword search without changing native files or cache', async () => {
      const before = snapshot(); const cacheBefore = hash(fs.readFileSync(recall.cachePath));
      assert.equal(fs.existsSync(path.join(extensionDir, 'memory', 'models', 'bge-small.onnx')), false);
      process.env.RECALL_MODEL_DIR = path.join(root, 'absent-cpu-model');
      await select(fixtures[0], 'search-fallback', 'lexical', 'code');
      assert.deepEqual(snapshot(), before);
      assert.equal(hash(fs.readFileSync(recall.cachePath)), cacheBefore, 'fallback must leave existing vectors unchanged');
      if (process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT === 'custom-override') assert.equal(fs.existsSync(path.join(home, '.codex')), false);
      return 'Actual Search shows the explicit unavailable-model/no-download warning, uses a keyword picker and still selects the exact BOM-decoded registry passage; no cache or native source rewrite.';
    });
  } finally {
    process.env.RECALL_MODEL_DIR = originalModelDir;
    recall.status = failed() ? 'failed' : 'passed';
    const names = ['extension.js', 'package.json', 'codexFeaturesUi.js', 'autoLearnWorkerRunner.js', 'src/auto-learn-worker.js',
      'src/codex-memory.js', 'src/codex-recall.js', 'memory/codex_recall.py', 'memory/recall.py'];
    const artifactHashes = Object.fromEntries(names.map((name) => [name, hash(fs.readFileSync(path.join(extensionDir, name)))]));
    fs.writeFileSync(reportPath, JSON.stringify({ vscodeVersion: vscode.version, nodeVersion: process.version, extensionDir,
      home, codexHome, codexLayout: process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT, results, artifactHashes, recall }, null, 2) + '\n');
    writeProgress(failed() ? 'review-runtime-failed' : 'codex-recall-complete', { detail: failed() ? results.find((item) => item.verdict === 'FAIL').detail : 'Focused semantic recall UI acceptance passed.' });
    if (failed()) throw new Error('Focused recall acceptance failed; see acceptance.json');
  }
};
