'use strict';

const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

exports.run = async function run() {
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_NATIVE_GATES_ONLY, '1');
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT, 'custom-override');
  const home = process.env.ACOLYTE_ACCEPTANCE_HOME;
  const codexHome = process.env.ACOLYTE_ACCEPTANCE_CODEX_HOME;
  const extensionDir = process.env.ACOLYTE_ACCEPTANCE_EXTENSION;
  const reportPath = process.env.ACOLYTE_ACCEPTANCE_REPORT;
  const root = path.dirname(reportPath);
  const progress = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
  const profile = { home, codexHome };
  const hash = (value) => createHash('sha256').update(value).digest('hex');
  const normalized = (value) => path.resolve(value).toLowerCase();
  const results = [];
  const gates = { steps: [], automatic: [], boundary: 'Actual owned editor dashboard, complete native-gate dialogs and real filesystem watchers. Synthetic explicitly annotated memory; isolated user instructions. The MCP receipt fixture uses actual config RPC without turns; its read-only UI must preserve all profile bytes.' };
  const waitFor = async (predicate, label, timeout = 20000) => {
    const deadline = Date.now() + timeout;
    do { const value = predicate(); if (value) return value; await new Promise((resolve) => setTimeout(resolve, 100)); }
    while (Date.now() < deadline);
    throw new Error('timed out waiting for ' + label);
  };
  const writeProgress = (phase, details = {}) => {
    fs.writeFileSync(progress + '.tmp', JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(progress + '.tmp', progress);
  };
  const check = async (name, body) => {
    try { results.push({ verdict: 'PASS', name, detail: await body() || '' }); }
    catch (error) { results.push({ verdict: 'FAIL', name, detail: error.stack || error.message }); }
  };
  const failed = () => results.some((item) => item.verdict === 'FAIL');
  const snapshot = () => {
    const output = {};
    const walk = (base) => {
      if (!fs.existsSync(base)) return;
      for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
        const file = path.join(base, entry.name);
        if (entry.isDirectory()) walk(file);
        else { assert.ok(entry.isFile()); output[file] = hash(fs.readFileSync(file)); }
      }
    };
    walk(codexHome); walk(path.join(home, '.claude')); walk(path.join(home, '.ai-acolyte')); return output;
  };
  const action = async (caseId, details, whileOpen) => {
    const ackPath = path.join(root, `native-gates-${caseId}.json`);
    assert.equal(fs.existsSync(ackPath), false);
    const readyPath = whileOpen ? path.join(root, `native-gates-${caseId}-ready.json`) : undefined;
    const continuePath = whileOpen ? path.join(root, `native-gates-${caseId}-continue.json`) : undefined;
    writeProgress('codex-native-gates-action', { caseId, ...details, ackPath, readyPath, continuePath });
    if (whileOpen) {
      await waitFor(() => fs.existsSync(readyPath), caseId + ' actual modal before fixture change');
      await whileOpen(); fs.writeFileSync(continuePath, JSON.stringify({ caseId, continue: true }));
    }
    const ack = await waitFor(() => fs.existsSync(ackPath) && JSON.parse(fs.readFileSync(ackPath, 'utf8')), caseId + ' actual UI acknowledgment', 45000);
    assert.equal(ack.caseId, caseId); assert.equal(ack.status, 'passed', ack.error || 'see renderer');
    gates.steps.push(ack); return ack;
  };
  const BEGIN = '<!-- BEGIN permission-wildcarding: native Codex memory gates (managed) -->';
  const END = '<!-- END permission-wildcarding: native Codex memory gates -->';
  const registry = path.join(codexHome, 'memories', 'MEMORY.md');
  const base = path.join(codexHome, 'AGENTS.md');
  const override = path.join(codexHome, 'AGENTS.override.md');
  let api, stripNative, baseUser, overrideUser;
  const source = (sentence, scope = 'global') => `---\nscope: ${scope}\n---\n# Fixture global memory\n<!-- gate -->\n${sentence}\n<!-- /gate -->\n`;
  const sentences = {
    initial: 'Verify the amber fixture before changing its selected policy.',
    updated: 'Check the violet fixture and preserve its documented boundary.',
    refilled: 'Keep the copper fixture evidence beside the requested change.',
    repaired: 'Record the silver fixture result before reporting completion.',
  };
  const statusAction = (caseId, expectedStatus) => action(caseId, { kind: 'status', expectedStatus });
  const inspect = () => api.inspectNativeCodexGates(profile);
  const assertUsers = () => {
    if (fs.existsSync(base)) assert.equal(stripNative(fs.readFileSync(base, 'utf8')), baseUser, 'base user/shared instruction bytes must survive');
    if (fs.existsSync(override)) assert.equal(stripNative(fs.readFileSync(override, 'utf8')), overrideUser, 'override user/shared instruction bytes must survive');
  };
  const expectCurrent = async (sentence, label) => {
    const report = await waitFor(() => {
      const value = inspect();
      return value.target.on && value.target.current && value.body.includes(sentence) && fs.readFileSync(value.target.path, 'utf8').includes(sentence) ? value : null;
    }, label);
    assertUsers(); gates.automatic.push({ label, path: report.target.path, body: report.body, bodyHash: report.bodyHash }); return report;
  };
  const reviewDetails = (decision, current, extra = {}) => ({ kind: 'review', expectedOn: !!current.target.on,
    expectedDecision: decision, expectedPath: current.target.path, expectedBody: current.body,
    expectedComplete: current.complete, ...extra });
  try {
    await check('selected native-gates extension activates in the owned Codex override profile', async () => {
      const extension = vscode.extensions.getExtension('local.permission-wildcarding');
      assert.ok(extension); assert.equal(normalized(extension.extensionPath), normalized(extensionDir));
      await extension.activate(); assert.ok(extension.isActive);
      assert.equal(vscode.workspace.getConfiguration('permissionWildcarding').get('autoLearn.enabled'), false);
      api = require(path.join(extensionDir, 'src/codex-memory-gates'));
      const guidance = require(path.join(extensionDir, 'src/agent-guidance'));
      const sharedGates = require(path.join(extensionDir, 'src/agent-gates'));
      const native = guidance.createManagedBlock({ begin: BEGIN, end: END, body: '' });
      stripNative = (text) => native.apply(text, false).text;
      const shared = (text) => sharedGates.makeGatesBlock(home).apply(guidance.applyGuidance(text, true).text, true).text;
      baseUser = shared('# Base fixture user notes\nBASE_USER_SENTINEL\n');
      overrideUser = shared('# Override fixture user notes\nOVERRIDE_USER_SENTINEL\n');
      fs.writeFileSync(base, baseUser);
      // Install while only the base exists, then introduce an override later.
      // Deleting the sole installed marker would deliberately remove the opt-in.
      fs.unlinkSync(override);
      fs.mkdirSync(path.dirname(registry), { recursive: true });
      fs.writeFileSync(registry, source(sentences.initial));
      fs.writeFileSync(path.join(path.dirname(registry), 'memory_summary.md'), 'v1\nFixture native gate summary.\n');
      const current = inspect(); assert.equal(current.canEnable, true); assert.equal(current.count, 1); assert.equal(current.target.on, false);
      gates.registry = registry; gates.base = base; gates.override = override; gates.compiledPath = current.compiledPath;
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
      return `VS Code ${vscode.version}; host ${process.version}; isolated custom CODEX_HOME; one explicitly annotated gate.`;
    });
    if (failed()) return;
    await check('actual Cancel preserves all profile bytes and Install writes only the reviewed native gate block', async () => {
      const before = snapshot();
      await action('cancel-install', reviewDetails('Cancel', inspect()));
      assert.deepEqual(snapshot(), before, 'WITNESS actual native gate Cancel preserves every byte');
      await action('install', reviewDetails('Install gates', inspect()));
      const current = await expectCurrent(sentences.initial, 'WITNESS actual Install creates the reviewed native gate block');
      assert.equal(current.target.path, base); assert.equal(fs.existsSync(override), false);
      const compiled = JSON.parse(fs.readFileSync(current.compiledPath, 'utf8'));
      assert.equal(compiled.body, current.body); assert.equal(compiled.bodyHash, current.bodyHash);
      assert.equal(fs.readFileSync(registry, 'utf8'), source(sentences.initial));
      return 'Actual full-body Cancel and Install controls; reviewed body and provenance appear in the active base file, while native sources and shared/user instruction bytes survive.';
    });
    if (failed()) return;
    await check('real filesystem events refresh edited gates, retain a zero sentinel and refill without commands', async () => {
      fs.writeFileSync(registry, source(sentences.updated));
      await expectCurrent(sentences.updated, 'WITNESS native gate watcher refreshes an edited installed body');
      await statusAction('status-updated', 'Native memory gates: 1 sections; current.');
      fs.writeFileSync(registry, source(sentences.updated, 'task'));
      const zero = await waitFor(() => { const value = inspect(); return value.count === 0 && value.target.on && value.target.current ? value : null; }, 'WITNESS complete zero keeps the native opt-in marker');
      assert.ok(fs.readFileSync(base, 'utf8').includes(BEGIN));
      assert.equal(fs.readFileSync(base, 'utf8').includes(sentences.updated), false); assertUsers();
      await statusAction('status-zero', 'Native memory gates: 0 sections; current.');
      fs.writeFileSync(registry, source(sentences.refilled));
      await expectCurrent(sentences.refilled, 'WITNESS existing empty native marker refills after new explicit annotations');
      await statusAction('status-refilled', 'Native memory gates: 1 sections; current.');
      gates.zero = { count: zero.count, body: zero.body, installedMarker: true };
      return 'Without Scan, Review or refresh commands, real file events update the installed body, retain its explicit opt-in when annotations become nonglobal, and refill it when global annotations return.';
    });
    if (failed()) return;
    await check('effective instruction-file changes migrate native gates while preserving shared and user blocks', async () => {
      assert.equal(inspect().target.path, base); assert.equal(inspect().target.current, true);
      await statusAction('status-base', 'Native memory gates: 1 sections; current.');
      fs.writeFileSync(override, overrideUser);
      await expectCurrent(sentences.refilled, 'WITNESS creating the override migrates native gates to the active file');
      assert.equal(inspect().target.path, override); assert.equal(fs.readFileSync(base, 'utf8'), baseUser);
      await statusAction('status-override', 'Native memory gates: 1 sections; current.');
      return 'Creating an override moves only the existing native block from the base into the newly active file and cleans the inactive copy. Both files retain their shared/user bytes.';
    });
    if (failed()) return;
    await check('malformed and unreadable native sources retain installed gates, show an error and remain removable', async () => {
      const held = fs.readFileSync(override);
      const errorText = 'Installed native Codex gates were retained: the source compilation is unreadable.';
      for (const [caseId, bytes] of [
        ['held-scope', Buffer.from(source(sentences.refilled, '"global'))],
        ['held-marker', Buffer.from(source(sentences.refilled).replace('<!-- /gate -->\n', ''))],
        ['held-utf8', Buffer.from([0xff, 0xfe, 0xfd])],
      ]) {
        fs.writeFileSync(registry, bytes);
        await statusAction(caseId, errorText);
        const invalid = inspect(); assert.equal(invalid.complete, false, 'WITNESS malformed native scope cannot be a complete zero result');
        assert.equal(invalid.compilationState, 'unreadable'); assert.equal(invalid.readable, true);
        assert.deepEqual(fs.readFileSync(override), held, 'WITNESS malformed native sources must retain installed instruction bytes');
        assertUsers();
        if (caseId !== 'held-utf8') {
          fs.writeFileSync(registry, source(sentences.refilled));
          await statusAction(caseId + '-repaired', 'Native memory gates: 1 sections; current.');
        }
      }
      await action('remove-unreadable', reviewDetails('Remove gates', inspect()));
      await waitFor(() => !inspect().target.on && !inspect().target.shadowedPaths.length, 'WITNESS actual Remove remains available for unreadable native sources');
      assert.equal(fs.readFileSync(override, 'utf8'), overrideUser); assert.equal(fs.readFileSync(base, 'utf8'), baseUser);
      fs.writeFileSync(registry, source(sentences.repaired));
      await statusAction('status-off', 'Native memory gates are off. Only explicitly marked global sections can be installed.');
      await new Promise((resolve) => setTimeout(resolve, 1200));
      assert.equal(inspect().target.on, false, 'WITNESS source repair must not reinstall a removed native block');
      assert.equal(fs.readFileSync(override, 'utf8'), overrideUser);
      return 'Malformed quoted scope, unpaired marker and invalid UTF-8 each retain the exact installed instructions with a visible error. Actual Remove works while sources are unreadable; repairing them does not reinstall the block.';
    });
    if (failed()) return;
    await check('native gate review refuses stale source bytes after the actual full-body modal opens', async () => {
      const before = { base: fs.readFileSync(base), override: fs.readFileSync(override), compiled: fs.readFileSync(gates.compiledPath) };
      await action('stale-install', reviewDetails('Install gates', inspect(), {
        expectedWarning: 'AI Acolyte: Native Codex gate review is stale; inspect the current sources and instruction targets again.' }), async () => {
        fs.writeFileSync(registry, source(sentences.initial));
      });
      assert.deepEqual(fs.readFileSync(base), before.base); assert.deepEqual(fs.readFileSync(override), before.override);
      assert.deepEqual(fs.readFileSync(gates.compiledPath), before.compiled);
      assert.equal(inspect().target.on, false);
      return 'The actual reviewed source body is changed while its modal is open; Install refuses the stale fingerprint and leaves both instruction files and compiled receipt unchanged.';
    });
    if (failed()) return;
    await check('saved MCP approvals remain visible and read-only after a concurrent config edit', async () => {
      const helper = require('../check-codex-mcp-runtime');
      const server = 'FixtureCase_' + hash(home).slice(0, 10);
      const context = helper.createMcpRuntimeContext({ extensionDir, home, codexHome, workspace: path.join(root, 'workspace'), serverName: server,
        fixtureServerPath: path.join(root, 'readonly-mcp-server.js'), logPath: path.join(root, 'readonly-mcp.log') });
      helper.writeMcpFixture(context);
      const config = require(path.join(extensionDir, 'src/codex-mcp-config'));
      const options = { ...profile, server, tool: 'ProbeCase' };
      const plan = config.planCodexMcpApproval(options); assert.equal(plan.supported, true);
      const granted = config.applyCodexMcpApproval({ server, tool: 'ProbeCase', expectedFingerprint: plan.fingerprint }, profile);
      assert.equal(granted.changed, true);
      fs.appendFileSync(path.join(codexHome, 'config.toml'), '\n# External fixture edit after the saved approval.\n');
      const inventory = config.listCodexMcpApprovals(profile);
      const receipt = inventory.find((item) => item.server === server && item.tool === 'ProbeCase');
      assert.ok(receipt && !receipt.restored && receipt.undoable === false);
      const before = snapshot();
      const ack = await action('mcp-readonly', { kind: 'mcp-readonly', expectedLabel: `${server} / ProbeCase`,
        expectedPath: path.join(codexHome, 'config.toml'), expectedReason: receipt.reason });
      assert.equal(ack.clicked, 'reviewCodexMcp');
      assert.deepEqual(snapshot(), before, 'WITNESS selecting an unrestorable MCP receipt must preserve every profile byte');
      gates.readonlyReceipt = { server, tool: 'ProbeCase', reason: receipt.reason, id: receipt.id };
      assert.equal(fs.existsSync(path.join(home, '.codex')), false);
      return 'An actual config-RPC approval receipt survives an external edit in the real picker as Saved approval needs review; selecting it shows the reason and writes nothing.';
    });
  } finally {
    gates.status = failed() ? 'failed' : 'passed';
    const names = ['extension.js', 'package.json', 'codexFeaturesUi.js', 'codexMemoryGatesUi.js', 'autoLearnWorkerRunner.js',
      'src/codex-memory-gates.js', 'src/codex-memory.js', 'src/codex-mcp-config.js', 'src/codex-mcp-review.js', 'src/auto-learn-worker.js'];
    const artifactHashes = Object.fromEntries(names.map((name) => [name, hash(fs.readFileSync(path.join(extensionDir, name)))]));
    fs.writeFileSync(reportPath, JSON.stringify({ vscodeVersion: vscode.version, nodeVersion: process.version, extensionDir, home, codexHome,
      codexLayout: process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT, results, artifactHashes, gates }, null, 2) + '\n');
    writeProgress(failed() ? 'review-runtime-failed' : 'codex-native-gates-complete', { detail: failed() ? results.find((item) => item.verdict === 'FAIL').detail : 'Native gate and read-only MCP UI acceptance passed.' });
    if (failed()) throw new Error('Native gates acceptance failed; see acceptance.json');
  }
};
