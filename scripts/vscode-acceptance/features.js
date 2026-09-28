'use strict';

// Focused native hook/memory UI acceptance. The regular nine groups stay in
// index.js. These controls operate only through the actual owned dashboard.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

exports.run = async function run() {
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_FEATURES_ONLY, '1');
  const home = process.env.ACOLYTE_ACCEPTANCE_HOME;
  const reportPath = process.env.ACOLYTE_ACCEPTANCE_REPORT;
  const root = path.dirname(reportPath);
  const codexHome = process.env.ACOLYTE_ACCEPTANCE_CODEX_HOME;
  const extensionDir = process.env.ACOLYTE_ACCEPTANCE_EXTENSION;
  const progress = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
  const normalized = (file) => path.resolve(file).toLowerCase();
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const results = [];
  const features = { hooks: [], memory: [], diagnostics: [], bom: [],
    boundary: 'Actual owned VS Code dashboard, modal, input and picker UI. Memory is an isolated native-format fixture; hook configuration does not review or activate trust in Codex.' };
  const writeProgress = (phase, details = {}) => {
    assert.equal(normalized(path.dirname(progress)), normalized(root));
    fs.writeFileSync(progress + '.tmp', JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(progress + '.tmp', progress);
  };
  const waitFor = async (predicate, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    do {
      const result = predicate();
      if (result) return result;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`timed out waiting for ${label}`);
  };
  const action = async (caseId, details) => {
    const ackPath = path.join(root, `codex-feature-${caseId}.json`);
    assert.equal(fs.existsSync(ackPath), false);
    writeProgress('codex-feature-action', { caseId, ...details, ackPath });
    const ack = await waitFor(() => fs.existsSync(ackPath) && JSON.parse(fs.readFileSync(ackPath, 'utf8')), `${caseId} real UI acknowledgement`, 60000);
    assert.equal(ack.caseId, caseId);
    assert.equal(ack.status, 'passed', ack.error || ack.detail || 'see renderer evidence');
    return ack;
  };
  const check = async (name, task) => {
    try { results.push({ verdict: 'PASS', name, detail: await task() || '' }); }
    catch (error) { results.push({ verdict: 'FAIL', name, detail: error.stack || error.message }); }
  };
  const snapshot = () => {
    const output = {};
    const walk = (base, prefix) => {
      if (!fs.existsSync(base)) return;
      for (const entry of fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const file = path.join(base, entry.name);
        const key = prefix + '/' + entry.name;
        if (entry.isDirectory()) walk(file, key);
        else if (entry.isFile()) output[key] = hash(fs.readFileSync(file));
        else throw new Error('fixture snapshot encountered a linked or unexpected path: ' + file);
      }
    };
    walk(codexHome, 'codex');
    walk(path.join(home, '.claude'), 'claude');
    walk(path.join(home, '.ai-acolyte'), 'acolyte');
    return output;
  };
  const protectedSnapshot = () => Object.fromEntries(Object.entries(snapshot()).filter(([key]) =>
    key !== 'codex/hooks.json' && !/^acolyte\/backups\/codex-hooks\.[a-f0-9]{16}\.pre-change\.json$/.test(key)));
  const diagnostics = (file) => vscode.languages.getDiagnostics(vscode.Uri.file(file))
    .filter((item) => item.source === 'Codex native memory')
    .map((item) => ({ code: item.code, message: item.message, severity: item.severity }));
  let memory;
  let summary;
  let registry;
  let reference;
  let registryText;
  let suffix;
  let activeExtensionPath;
  try {
    await check('the focused native extension activates in the owned custom Codex profile', async () => {
      const extension = vscode.extensions.getExtension('local.permission-wildcarding');
      assert.ok(extension);
      assert.equal(normalized(extension.extensionPath), normalized(extensionDir));
      activeExtensionPath = extension.extensionPath;
      await extension.activate();
      assert.ok(extension.isActive);
      // VS Code's file URI loader lowercases the Windows drive letter. Use the
      // actual loaded module spelling for the command's exact review text.
      const loadedUi = Object.keys(require.cache).find((file) => normalized(file) === normalized(path.join(extensionDir, 'codexFeaturesUi.js')));
      assert.ok(loadedUi, 'the native host must have loaded its selected features UI module');
      activeExtensionPath = path.dirname(loadedUi);
      assert.equal(vscode.workspace.getConfiguration('permissionWildcarding').get('autoLearn.enabled'), false);
      assert.ok(fs.existsSync(path.join(extensionDir, 'codexFeaturesUi.js')));
      assert.ok(fs.existsSync(path.join(extensionDir, 'codexMemoryLint.js')));
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
      return `VS Code ${vscode.version}; extension-host ${process.version}; ${extensionDir}`;
    });
    if (results.some((item) => item.verdict === 'FAIL')) return;
    await check('actual hook Cancel, Configure and Remove preserve other hooks and leave Codex trust untouched', async () => {
      const { inspectCodexHook } = require(path.join(activeExtensionPath, 'src/codex-hook-install.js'));
      const hookPath = path.join(codexHome, 'hooks.json');
      const ownHook = { matcher: 'fixture-user-hook', hooks: [{ type: 'command', command: 'echo ACOLYTE_USER_HOOK', timeout: 3 }] };
      const ownConfig = { fixture: 'user-owned hook configuration', hooks: { Stop: [ownHook] } };
      const original = JSON.stringify(ownConfig, null, 2) + '\n';
      fs.writeFileSync(hookPath, original);
      const configPath = path.join(codexHome, 'config.toml');
      fs.writeFileSync(configPath, '# Keep this user-owned Codex configuration.\n');
      const profile = { home, codexHome };
      const definition = inspectCodexHook(profile).definition;
      const expectedCommand = definition.hooks[0].commandWindows;
      const ask = async (caseId, expectedDecision) => {
        const removing = caseId === 'hook-remove';
        const ack = await action(caseId, { kind: 'hook', expectedPath: hookPath, expectedCommand, expectedDecision,
          expectedTitle: removing ? 'Remove Codex after-turn learning?' : 'Learn from Codex turns while the editor is closed?',
          expectedDetailIncludes: removing ? ['Other hooks and the current Auto Learn mode are preserved.']
            : ['current Auto Learn mode', 'review this exact hook in Codex /hooks before it can run.'] });
        assert.equal(ack.clicked, 'codexHook');
        assert.equal(ack.modalDecision, expectedDecision);
        assert.ok(ack.dialogText.includes(expectedCommand));
        assert.ok(ack.dialogText.includes(hookPath));
        features.hooks.push(ack);
      };
      const beforeCancel = snapshot();
      await ask('hook-cancel', 'Cancel');
      assert.deepEqual(snapshot(), beforeCancel, 'WITNESS hook Cancel must preserve every profile byte');
      const protectedBefore = protectedSnapshot();
      await ask('hook-configure', 'Configure hook');
      await waitFor(() => inspectCodexHook(profile).configured, 'actual Configure hook write');
      const configured = JSON.parse(fs.readFileSync(hookPath, 'utf8'));
      assert.equal(configured.hooks.Stop.length, 2);
      assert.deepEqual(configured.hooks.Stop[0], ownHook);
      assert.deepEqual(configured.hooks.Stop[1], definition);
      assert.equal(configured.fixture, ownConfig.fixture);
      assert.equal(inspectCodexHook(profile).reviewRequired, true);
      assert.equal(inspectCodexHook(profile).trust, 'not-verified');
      assert.deepEqual(protectedSnapshot(), protectedBefore, 'configuration must not alter trust, instructions, learner state or policy');
      await ask('hook-remove', 'Remove hook');
      await waitFor(() => !inspectCodexHook(profile).configured, 'actual Remove hook write');
      assert.deepEqual(JSON.parse(fs.readFileSync(hookPath, 'utf8')), ownConfig);
      assert.deepEqual(protectedSnapshot(), protectedBefore);
      features.hookPath = hookPath;
      features.definition = definition;
      return 'Actual full-command review, Cancel, Configure and Remove; unrelated hook and every protected profile file remain unchanged; trust still requires Codex review.';
    });
    if (results.some((item) => item.verdict === 'FAIL')) return;
    await check('native memory creation reaches ambient diagnostics through the actual filesystem watcher', async () => {
      memory = path.join(codexHome, 'memories');
      assert.equal(fs.existsSync(memory), false, 'memory fixture must start absent');
      const absent = await action('memory-empty', { kind: 'memory-status', expectedRoot: memory,
        expectedBadgeIncludes: ['no files yet'], expectedDetailIncludes: ['feature enablement is not inferred'] });
      features.memory.push(absent);
      // Startup work has settled while the fixture still has no memory files.
      // Later repair/deletion checks also require fresh watcher-driven updates.
      await new Promise((resolve) => setTimeout(resolve, 1500));
      suffix = hash(home).slice(0, 10);
      summary = path.join(memory, 'memory_summary.md');
      registry = path.join(memory, 'MEMORY.md');
      reference = path.join(memory, 'rollout_summaries', `acolyte-memory-${suffix}.md`);
      registryText = `# Task: Acolyte native fixture ${suffix}\n\nNebulaprism${suffix} uses the amber connection.\n`;
      fs.mkdirSync(path.dirname(reference), { recursive: true });
      fs.writeFileSync(registry, registryText);
      fs.writeFileSync(summary, `v0\nNative fixture summary.\nrollout_summaries/acolyte-memory-${suffix}.md\n`);
      const values = await waitFor(() => {
        const items = diagnostics(summary);
        return items.some((item) => item.code === 'summary-version') && items.some((item) => item.code === 'missing-reference') ? items : null;
      }, 'WITNESS actual memory watcher publishes summary and reference diagnostics');
      assert.equal(values.length, 2);
      features.diagnostics.push({ phase: 'created', path: summary, values });
      return 'Creation of the previously absent native memory store publishes two real Codex memory Problems diagnostics without a manual refresh.';
    });
    if (results.some((item) => item.verdict === 'FAIL')) return;
    await check('actual native-memory Search selects the registry passage and Inspect shows its diagnostics without writing files', async () => {
      const before = snapshot();
      const search = await action('memory-search', { kind: 'search', query: `nebulaprism${suffix}`,
        expectedLabel: `Task: Acolyte native fixture ${suffix}`, expectedDescription: 'MEMORY.md:1',
        expectedDetailIncludes: [`Nebulaprism${suffix} uses the amber connection.`], expectedPath: registry });
      assert.equal(search.clicked, 'searchCodexMemory');
      assert.equal(search.selectedLabel, `Task: Acolyte native fixture ${suffix}`);
      const editor = await waitFor(() => normalized(vscode.window.activeTextEditor?.document.uri.fsPath || root) === normalized(registry)
        ? vscode.window.activeTextEditor : null, 'actual selected registry source document');
      assert.equal(editor.document.getText(editor.selection), registryText, 'WITNESS Search must select the exact current native registry passage');
      features.memory.push(search);
      const inspect = await action('memory-inspect', { kind: 'inspect', expectedRoot: memory,
        expectedDetailIncludes: ['Codex native memory', 'feature enablement: unknown', 'memory_summary.md', 'MEMORY.md',
          'does not start with the v1 format marker', `rollout_summaries/acolyte-memory-${suffix}.md`] });
      assert.equal(inspect.clicked, 'inspectCodexMemory');
      const inspection = await waitFor(() => {
        const current = vscode.window.activeTextEditor;
        return current?.document.isUntitled && current.document.getText().includes('Codex native memory') ? current.document.getText() : null;
      }, 'actual memory inspection document');
      for (const text of ['Storage: readable; feature enablement: unknown', 'does not enable or generate memories',
        'does not start with the v1 format marker', `Selected-memory reference is missing or unreadable: rollout_summaries/acolyte-memory-${suffix}.md`]) assert.ok(inspection.includes(text));
      assert.ok(!/200.line|over budget/i.test(inspection));
      assert.deepEqual(snapshot(), before, 'native memory search and inspection must be read-only');
      features.memory.push({ ...inspect, documentText: inspection });
      return 'Actual query/picker opens and selects the exact registry passage; actual Inspect renders native summary/reference diagnostics and unknown feature state; all profile bytes preserved.';
    });
    if (results.some((item) => item.verdict === 'FAIL')) return;
    await check('ambient native-memory diagnostics clear and return after repairs and deletion without a refresh command', async () => {
      fs.writeFileSync(summary, `v1\nNative fixture summary.\nrollout_summaries/acolyte-memory-${suffix}.md\n`);
      fs.writeFileSync(reference, '# Fixture rollout\nThe amber connection was checked.\n');
      await waitFor(() => diagnostics(summary).length === 0, 'WITNESS repaired native files clear actual diagnostics');
      features.diagnostics.push({ phase: 'repaired', path: summary, values: diagnostics(summary) });
      fs.unlinkSync(reference);
      const missing = await waitFor(() => {
        const items = diagnostics(summary);
        return items.length === 1 && items[0].code === 'missing-reference' ? items : null;
      }, 'WITNESS deleting a referenced native memory restores its diagnostic');
      features.diagnostics.push({ phase: 'reference-deleted', path: summary, values: missing });
      fs.unlinkSync(summary);
      await waitFor(() => diagnostics(summary).length === 0, 'WITNESS deleting the diagnosed native file clears stale Problems');
      features.diagnostics.push({ phase: 'summary-deleted', path: summary, values: diagnostics(summary) });
      if (process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT === 'custom-override') assert.equal(fs.existsSync(path.join(home, '.codex')), false);
      return 'Real filesystem events clear repaired diagnostics, restore the missing-reference diagnostic, and clear deleted-file Problems entries.';
    });
    if (results.some((item) => item.verdict === 'FAIL')) return;
    await check('actual native-memory search maps both first and later UTF-8 BOM passages into editor selections', async () => {
      const first = `# Task: Acolyte BOM first ${suffix}\n\nBomfirst${suffix} uses the copper path.\n\n`;
      const later = `# Task: Acolyte BOM later ${suffix}\n\nBomlater${suffix} uses the violet path.\n`;
      const documentText = first + later;
      fs.writeFileSync(registry, Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from(documentText)]));
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(registry));
      await waitFor(() => document.getText() === documentText, 'real TextDocument decodes the native BOM fixture');
      assert.deepEqual([...fs.readFileSync(registry).subarray(0, 3)], [0xef, 0xbb, 0xbf]);
      const before = snapshot();
      // The ordinary search group already proved opening the source. Here an
      // explicitly empty real selection isolates the BOM-to-editor offset map;
      // a stale-location return cannot inherit a passing selection by accident.
      for (const entry of [
        { part: 'later', line: 5, text: later, sentence: `Bomlater${suffix} uses the violet path.` },
        { part: 'first', line: 1, text: first, sentence: `Bomfirst${suffix} uses the copper path.` },
      ]) {
        const editor = await vscode.window.showTextDocument(document, { preview: true });
        editor.selection = new vscode.Selection(0, 0, 0, 0);
        const caseId = `memory-search-bom-${entry.part}`;
        const ack = await action(caseId, { kind: 'search', query: `bom${entry.part}${suffix}`,
          expectedLabel: `Task: Acolyte BOM ${entry.part} ${suffix}`, expectedDescription: `MEMORY.md:${entry.line}`,
          expectedDetailIncludes: [entry.sentence], expectedPath: registry });
        assert.equal(ack.clicked, 'searchCodexMemory');
        assert.equal(ack.selectedLabel, `Task: Acolyte BOM ${entry.part} ${suffix}`);
        const active = vscode.window.activeTextEditor;
        assert.equal(normalized(active.document.uri.fsPath), normalized(registry));
        assert.equal(active.document.getText(active.selection), entry.text,
          `WITNESS BOM ${entry.part} search must select the exact decoded passage`);
        features.bom.push({ caseId, ui: ack, selectedText: active.document.getText(active.selection),
          start: { line: active.selection.start.line, character: active.selection.start.character },
          end: { line: active.selection.end.line, character: active.selection.end.character } });
      }
      assert.deepEqual(snapshot(), before, 'BOM native memory search must not rewrite its source or profile');
      return 'Actual later and first BOM registry searches select exact decoded passages, including first-heading recognition, without rewriting the BOM source.';
    });
  } finally {
    const failed = results.some((item) => item.verdict === 'FAIL');
    features.status = failed ? 'failed' : 'passed';
    const artifacts = ['extension.js', 'package.json', 'codexFeaturesUi.js', 'codexMemoryLint.js', 'autoLearnWorkerRunner.js',
      'src/codex-memory.js', 'src/codex-hook-install.js', 'src/codex-hook-config.js', 'src/codex-stop-hook.js', 'src/auto-learn-worker.js'];
    const artifactHashes = Object.fromEntries(artifacts.filter((file) => fs.existsSync(path.join(extensionDir, file)))
      .map((file) => [file, hash(fs.readFileSync(path.join(extensionDir, file)))]));
    fs.writeFileSync(reportPath, JSON.stringify({ vscodeVersion: vscode.version, nodeVersion: process.version, extensionDir,
      home, codexHome, codexLayout: process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT, results, artifactHashes, features }, null, 2) + '\n');
    writeProgress(failed ? 'review-runtime-failed' : 'codex-features-complete', {
      detail: failed ? results.find((item) => item.verdict === 'FAIL').detail : 'Focused native hook and memory UI acceptance passed.' });
    if (failed) throw new Error('Focused feature acceptance failed; see acceptance.json');
  }
};
