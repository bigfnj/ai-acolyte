'use strict';
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const normalizedPath = (value) => path.resolve(value).toLowerCase();

exports.run = async function run() {
  const root = process.env.ACOLYTE_BACKGROUND_ROOT;
  assert.ok(root && path.isAbsolute(root) && path.basename(root).startsWith('acolyte-background-'));
  const extensionDir = process.env.ACOLYTE_BACKGROUND_EXTENSION;
  const route = process.env.ACOLYTE_BACKGROUND_ROUTE;
  const layout = process.env.ACOLYTE_BACKGROUND_LAYOUT;
  const mutation = process.env.ACOLYTE_BACKGROUND_MUTATION;
  const home = path.join(root, 'home');
  const workspace = path.join(root, 'workspace');
  const codexHome = layout === 'custom-override' ? path.join(root, 'custom-codex') : path.join(home, '.codex');
  assert.equal(normalizedPath(os.homedir()), normalizedPath(home));
  assert.equal(normalizedPath(process.env.CODEX_HOME), normalizedPath(codexHome));
  assert.equal(normalizedPath(vscode.workspace.workspaceFolders[0].uri.fsPath), normalizedPath(workspace));
  const startedAt = Date.now();
  const report = { route, layout, mutation, extensionDir, root, home, codexHome,
    vscodeVersion: vscode.version, nodeVersion: process.version, startedAt: new Date(startedAt).toISOString(),
    boundary: 'Actual editor-host watcher and interval routes plus real Codex history. No Scan command, timer acceleration, VS Code mock, provider credentials or inference. Periodic fixture intentionally drops Codex watcher scheduling.', results: [] };
  const readState = () => {
    const dir = path.join(home, '.claude', 'wildcarding');
    if (!fs.existsSync(dir)) return null;
    const names = fs.readdirSync(dir).filter((name) => /^auto-learn-state.*\.json$/.test(name));
    assert.ok(names.length <= 1);
    return names.length ? JSON.parse(fs.readFileSync(path.join(dir, names[0]), 'utf8')) : null;
  };
  const callbacks = () => {
    const file = path.join(home, 'background-callbacks.jsonl');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)) : [];
  };
  const waitFor = async (predicate, timeout, message) => {
    const deadline = Date.now() + timeout;
    do {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    assert.fail(message);
  };
  const check = async (name, task) => {
    try { await task(); report.results.push({ verdict: 'PASS', name }); }
    catch (error) { report.results.push({ verdict: 'FAIL', name, detail: error.stack || error.message }); }
  };
  let candidateName;
  let baseline;
  const findCandidate = () => Object.values(readState()?.candidates || {}).find((item) => item.prefix.join(' ') === candidateName);
  try {
    await check('the selected native extension completes startup before new history exists', async () => {
      const extension = vscode.extensions.getExtension('local.permission-wildcarding');
      assert.ok(extension);
      assert.equal(normalizedPath(extension.extensionPath), normalizedPath(extensionDir));
      await extension.activate();
      assert.ok(extension.isActive);
      const config = vscode.workspace.getConfiguration('permissionWildcarding');
      assert.equal(config.get('autoLearn.enabled'), true);
      assert.equal(config.get('autoLearn.mode'), 'recommend');
      assert.equal(config.get('autoLearn.intervalMinutes'), route === 'periodic' ? 1 : 60);
      assert.equal(config.get('autoLearn.debounceSeconds'), 1);
      await waitFor(() => readState()?.lastScanAt, 15000, 'initial background scan did not finish');
      await new Promise((resolve) => setTimeout(resolve, 1500));
      baseline = readState();
      assert.equal(Object.keys(baseline.candidates).length, 0, 'startup unexpectedly contains a learned candidate');
      assert.equal(baseline.lastScanStats.errors, 0);
      assert.equal(baseline.lastScanStats.partial, 0);
      report.initialScanAt = baseline.lastScanAt;
      report.initialScanStats = baseline.lastScanStats;
    });
    if (report.results.some((item) => item.verdict === 'FAIL')) return;
    await check('a real successful Codex execution produces the new completed transcript', async () => {
      const { createRuntimeContext, runtimeCase, rolloutFor, assertAllowed } = require('../check-codex-runtime.js');
      const suffix = createHash('sha256').update(root).digest('hex').slice(0, 10);
      candidateName = `acolyte-background-${suffix}.cmd`;
      const witness = `ACOLYTE_BACKGROUND_${suffix}`;
      fs.writeFileSync(path.join(workspace, candidateName), `@echo off\r\necho ${witness}\r\n`);
      assert.equal(findCandidate(), undefined);
      report.beforeExecutionAt = Date.now();
      const context = createRuntimeContext({ extensionDir, home, codexHome, workspace, commandName: candidateName,
        shellWitness: witness, approvalDecision: 'accept', customLayout: layout === 'custom-override',
        instructionWitnesses: { user: 'Keep this background user instruction.', gate: 'No background gate exists.',
          ...(layout === 'custom-override' ? { shadowed: 'This background base remains untouched.' } : {}) } });
      const runtime = await runtimeCase(context, 'unattended-history', 'observe', false);
      assertAllowed(runtime, 1);
      report.runtime = runtime;
      const file = rolloutFor(codexHome, runtime.threadId);
      assert.ok(fs.existsSync(file));
      const { scanHistoryFiles } = require(path.join(extensionDir, 'src/history-adapters.js'));
      const parsed = scanHistoryFiles({ codexRoots: [path.join(codexHome, 'sessions')], platform: 'win32' });
      const successes = parsed.observations.filter((item) => item.status === 'success' && item.command.includes(candidateName));
      assert.equal(successes.length, 1);
      report.transcript = { path: file, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex'), successId: successes[0].id };
      report.completedExecutionAt = Date.now();
    });
    if (report.results.some((item) => item.verdict === 'FAIL')) return;
    await check(route === 'watcher' ? 'the actual Codex watcher learns the completed call without a Scan command'
      : 'the actual periodic callback learns a completed call after its watcher scheduling was missed', async () => {
      if (route === 'periodic' || mutation === 'watcher-noop') {
        await waitFor(() => callbacks().some((item) => item.kind === 'codex-watcher-skipped'), 15000,
          'the intended Codex filesystem callback was not executed');
      }
      if (route === 'periodic') {
        assert.ok(Date.now() - startedAt < 25000, 'fixture took too long to distinguish the first periodic tick');
        await new Promise((resolve) => setTimeout(resolve, 5000));
        assert.equal(findCandidate(), undefined, 'missed-watcher fixture was learned before its periodic tick');
        assert.equal(readState().lastScanAt, baseline.lastScanAt, 'another background route scanned before the periodic tick');
        report.beforeTick = { at: Date.now(), candidateAbsent: true, lastScanAt: readState().lastScanAt };
        await waitFor(() => callbacks().some((item) => item.kind === 'periodic-tick'), 70000,
          'the actual one-minute periodic callback did not execute');
      }
      const item = await waitFor(findCandidate, 15000,
        route === 'watcher' ? 'WITNESS Codex watcher did not ingest the completed transcript' : 'WITNESS periodic reconciliation did not ingest the missed transcript');
      assert.equal(item.counts.success, 1);
      assert.equal(item.sourceCounts.codex.success, 1);
      assert.equal(item.sourceCounts.claude?.success || 0, 0);
      const observations = Object.entries(readState().observationHashes).filter(([, value]) => value.key === item.key);
      assert.equal(observations.length, 1);
      assert.deepEqual(observations[0][1], { key: item.key, outcome: 'success', source: 'codex' });
      assert.ok(readState().lastScanAt > baseline.lastScanAt);
      assert.equal(readState().applied.codex.length, 0);
      report.learned = { key: item.key, counts: item.counts, sourceCounts: item.sourceCounts, observations,
        lastScanAt: readState().lastScanAt, observedAt: Date.now() };
      if (layout === 'custom-override') assert.equal(fs.existsSync(path.join(home, '.codex')), false);
    });
  } finally {
    report.callbacks = callbacks();
    report.finalState = readState();
    report.artifactHashes = Object.fromEntries(['extension.js', 'src/auto-learn-manager.js', 'src/history-adapters.js', 'autoLearnWorkerRunner.js']
      .map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(extensionDir, file))).digest('hex')]));
    report.completedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - startedAt;
    fs.writeFileSync(path.join(root, 'background.json'), JSON.stringify(report, null, 2) + '\n');
    if (report.results.some((item) => item.verdict === 'FAIL')) throw new Error('Background acceptance failed; see background.json');
  }
};
