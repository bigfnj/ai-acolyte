'use strict';

// Real MCP history, actual editor UI, native config RPC and fresh Codex turns.
// Every server, transcript, configuration and recovery fixture belongs to the
// launcher-owned profile; no vscode mocks or provider inference are used.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');

exports.run = async function run() {
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_MCP_ONLY, '1');
  const home = process.env.ACOLYTE_ACCEPTANCE_HOME;
  const reportPath = process.env.ACOLYTE_ACCEPTANCE_REPORT;
  const root = path.dirname(reportPath);
  const codexHome = process.env.ACOLYTE_ACCEPTANCE_CODEX_HOME;
  const extensionDir = process.env.ACOLYTE_ACCEPTANCE_EXTENSION;
  const progress = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const normalized = (file) => path.resolve(file).toLowerCase();
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const suffix = hash(root).slice(0, 10);
  const serverName = `FixtureCase_${suffix}`;
  const tool = 'ProbeCase';
  const key = `codex-mcp:${JSON.stringify([serverName, tool])}`;
  const configPath = path.join(codexHome, 'config.toml');
  const ledgerPath = path.join(home, '.ai-acolyte', `codex-mcp.${hash(normalized(codexHome)).slice(0, 16)}.json`);
  const results = [];
  const mcp = { steps: [], cases: [], serverName, tool, key, configPath, ledgerPath,
    boundary: 'Actual MCP app-server history, native editor review dialogs, native config RPC and fresh Codex turns. Harmless owned stdio fixture, scripted loopback provider, no credentials or inference. Recovery fixtures interrupt only owned config transactions.' };
  const writeProgress = (phase, details = {}) => {
    assert.equal(normalized(path.dirname(progress)), normalized(root));
    fs.writeFileSync(progress + '.tmp', JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(progress + '.tmp', progress);
  };
  const waitFor = async (predicate, label, timeout = 25000) => {
    const end = Date.now() + timeout;
    do {
      const value = predicate();
      if (value) return value;
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < end);
    throw new Error(`timed out waiting for ${label}`);
  };
  const check = async (name, task) => {
    try { results.push({ verdict: 'PASS', name, detail: await task() || '' }); }
    catch (error) { results.push({ verdict: 'FAIL', name, detail: error.stack || error.message }); }
  };
  const failed = () => results.some((item) => item.verdict === 'FAIL');
  const collect = (base) => fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      assert.ok(!entry.isSymbolicLink(), 'owned fixture snapshot must not follow links');
      const file = path.join(base, entry.name);
      return entry.isDirectory() ? collect(file) : entry.isFile() && !entry.name.endsWith('.lock') ? [file] : [];
    }) : [];
  const snapshot = () => Object.fromEntries([
    ...collect(path.join(home, '.claude')), ...collect(path.join(home, '.ai-acolyte')),
    ...collect(path.join(codexHome, 'rules')), configPath,
    ...['AGENTS.md', 'AGENTS.override.md'].map((file) => path.join(codexHome, file)).filter(fs.existsSync),
  ].filter(fs.existsSync).sort().map((file) => [file, hash(fs.readFileSync(file))]));
  const ledger = () => fs.existsSync(ledgerPath) ? JSON.parse(fs.readFileSync(ledgerPath, 'utf8')) : { pending: null, receipts: [] };
  const action = async (caseId, details, whileModal) => {
    const ackPath = path.join(root, `codex-mcp-${caseId}.json`);
    const readyPath = path.join(root, `codex-mcp-${caseId}-ready.json`);
    const continuePath = path.join(root, `codex-mcp-${caseId}-continue.json`);
    assert.equal(fs.existsSync(ackPath), false);
    writeProgress('codex-mcp-action', { caseId, serverName, tool, expectedLabel: `${serverName} / ${tool}`,
      expectedPath: configPath, ...details, ackPath, ...(whileModal ? { readyPath, continuePath } : {}) });
    if (whileModal) {
      await waitFor(() => fs.existsSync(readyPath), `${caseId} actual confirmation is open`, 60000);
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      assert.equal(ready.caseId, caseId); assert.equal(ready.status, 'modal-open');
      await whileModal();
      fs.writeFileSync(continuePath, JSON.stringify({ caseId, status: 'continue' }) + '\n');
    }
    const ack = await waitFor(() => fs.existsSync(ackPath) && JSON.parse(fs.readFileSync(ackPath, 'utf8')), `${caseId} actual UI acknowledgement`, 60000);
    assert.equal(ack.caseId, caseId); assert.equal(ack.status, 'passed', ack.error || 'MCP UI failed');
    assert.equal(ack.clicked, 'reviewCodexMcp'); assert.equal(ack.modalDecision, details.expectedDecision);
    mcp.steps.push(ack);
    return ack;
  };
  const approvalDetails = ['3 successful, 1 failed, 0 unknown runs.', 'Current effective mode: prompt.',
    'New per-tool mode: approve.', 'including different arguments.', 'Tool behavior is not classified as safe.',
    'This user setting applies across workspaces.', 'Other tools, server settings and project trust are preserved.', 'Restart Codex'];
  const approve = (caseId, decision, extra = {}, whileModal) => action(caseId, {
    expectedDescription: 'Review exact tool approval', expectedTitle: 'Approve this exact Codex MCP tool?',
    expectedDecision: decision, expectedDetailIncludes: approvalDetails, ...extra,
  }, whileModal);
  const recover = (caseId) => action(caseId, { expectedDescription: null,
    expectedTitle: 'Resolve interrupted Codex MCP change?', expectedDecision: 'Resolve change',
    expectedDetailIncludes: ['An unwritten change is cancelled; a completed exact change is recorded.',
      'Other edits require manual review.', 'This does not retry the config write.'] });
  let manager;
  let managerOptions;
  let createAutoLearnManager;
  let config;
  let runRuntime;
  let stateAfterScan;
  let originalClaude;
  let originalRules;
  let initialUserConfig;
  let approvedReceipt;
  const state = () => JSON.parse(fs.readFileSync(manager.paths.state, 'utf8'));
  const candidate = () => state().candidates[key];
  const inspect = () => config.inspectCodexMcpTool({ ...managerOptions, server: serverName, tool });
  try {
    await check('the exact MCP native fixture activates in the selected isolated extension', async () => {
      const extension = vscode.extensions.getExtension('local.permission-wildcarding');
      assert.ok(extension); assert.equal(normalized(extension.extensionPath), normalized(extensionDir));
      await extension.activate(); assert.ok(extension.isActive);
      assert.equal(vscode.workspace.getConfiguration('permissionWildcarding').get('autoLearn.enabled'), false);
      ({ createAutoLearnManager } = require(path.join(extensionDir, 'src/auto-learn-manager.js')));
      config = require(path.join(extensionDir, 'src/codex-mcp-config.js'));
      managerOptions = { home, codexHome, workspaceRoot: workspace, codexRulesPath: path.join(codexHome, 'rules', 'permission-wildcarding.rules'), mode: 'recommend' };
      manager = createAutoLearnManager(managerOptions);
      originalClaude = fs.readFileSync(manager.paths.claudeSettings, 'utf8');
      originalRules = fs.readFileSync(manager.paths.codexRules, 'utf8');
      const { createMcpRuntimeContext, writeMcpFixture, mcpRuntimeCase } = require('../check-codex-mcp-runtime.js');
      const context = createMcpRuntimeContext({ extensionDir, home, codexHome, workspace, serverName,
        fixtureServerPath: path.join(root, `mcp-server-${suffix}.cjs`), logPath: path.join(root, `mcp-calls-${suffix}.jsonl`) });
      assert.equal(fs.existsSync(configPath), false, 'MCP fixture must never overwrite existing configuration');
      writeMcpFixture(context);
      fs.writeFileSync(configPath, '# User-owned MCP fixture note must survive reviewed writes.\n' + fs.readFileSync(configPath, 'utf8'));
      runRuntime = async (name, selectedTool, args, decision, expected) => {
        const before = fs.readFileSync(configPath);
        const observed = await mcpRuntimeCase(context, name, { tool: selectedTool, arguments: args, approvalDecision: decision });
        mcp.cases.push(observed);
        assert.equal(observed.error, undefined, `${name}: actual MCP runtime failed`);
        assert.equal(observed.serverRequests.length, expected.approvals, `${name}: exact actual approval count`);
        for (const request of observed.serverRequests) {
          assert.equal(request.method, 'mcpServer/elicitation/request');
          assert.equal(request.params.serverName, serverName);
          assert.equal(request.params._meta.codex_approval_kind, 'mcp_tool_call');
        }
        const calls = observed.mcpCalls.filter((item) => item.method === 'tools/call');
        assert.equal(calls.length, expected.executed, `${name}: witnessed local tool execution count`);
        if (calls.length) { assert.equal(calls[0].params.name, selectedTool); assert.deepEqual(calls[0].params.arguments, args); }
        const ends = observed.records.filter((item) => item.type === 'event_msg' && item.payload.type === 'mcp_tool_call_end');
        assert.equal(ends.length, 1); assert.equal(ends[0].payload.invocation.server, serverName); assert.equal(ends[0].payload.invocation.tool, selectedTool);
        if (expected.executed) {
          assert.ok(ends[0].payload.result.Ok); assert.equal(ends[0].payload.result.Ok.isError, args.shouldFail);
        } else assert.ok(Object.hasOwn(ends[0].payload.result, 'Err'));
        const items = observed.events.filter((item) => item.method === 'item/completed' && item.params.item.type === 'mcpToolCall');
        assert.equal(items.length, 1); assert.equal(items[0].params.item.status, expected.status);
        assert.deepEqual(fs.readFileSync(configPath), before, 'runtime helper must consume current config without rewriting it');
        if (stateAfterScan) assert.equal(fs.readFileSync(manager.paths.state, 'utf8'), stateAfterScan, 'background learning must stay disabled');
        assert.equal(fs.readFileSync(manager.paths.claudeSettings, 'utf8'), originalClaude, 'Codex MCP evidence must not grant Claude permissions');
        assert.equal(fs.readFileSync(manager.paths.codexRules, 'utf8'), originalRules, 'MCP approvals must not enter shell rules');
        const user = observed.configRead.layers.find((layer) => layer.name?.type === 'user'
          && typeof layer.name.file === 'string' && normalized(layer.name.file) === normalized(configPath));
        assert.ok(user); observed.nativeUserConfig = user.config;
        return observed;
      };
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
      return `VS Code ${vscode.version}; host ${process.version}; exact mixed-case identity ${serverName} / ${tool}.`;
    });
    if (failed()) return;
    await check('actual successful and failed MCP history becomes one exact Codex-only candidate through manual scan', async () => {
      assert.equal(candidate(), undefined);
      for (let i = 0; i < 3; i++) {
        const result = await runRuntime(`observed-success-${i}`, tool, { shouldFail: false, marker: `before-${i}` }, 'accept',
          { approvals: 1, executed: 1, status: 'completed' });
        initialUserConfig ??= result.nativeUserConfig;
      }
      await runRuntime('observed-failure', tool, { shouldFail: true, marker: 'known-failed-outcome' }, 'accept',
        { approvals: 1, executed: 1, status: 'failed' });
      assert.equal(candidate(), undefined, 'actual new history must be absent before the explicit Scan command');
      await vscode.commands.executeCommand('permission-wildcarding.autoLearnScan');
      const learned = await waitFor(() => candidate(), 'actual MCP transcript scan');
      assert.equal(learned.kind, 'tool'); assert.equal(learned.tool, 'CodexMCP'); assert.deepEqual(learned.prefix, [serverName, tool]);
      assert.deepEqual(learned.sources, ['codex']); assert.equal(learned.claudePermission, null);
      assert.deepEqual(learned.counts, { success: 3, failed: 1, unknown: 0, total: 4 }, 'WITNESS actual MCP failures must not become successful evidence');
      const view = manager.codexMcpInventory();
      const item = view.candidates.find((entry) => entry.key === key); assert.ok(item?.eligible);
      assert.deepEqual(item.counts, learned.counts); assert.equal(view.receipts.length, 0); assert.equal(view.pending, null);
      const cursorBefore = state().cursors;
      await vscode.commands.executeCommand('permission-wildcarding.autoLearnScan');
      assert.deepEqual(candidate().counts, learned.counts, 'unchanged MCP rollouts must deduplicate');
      assert.deepEqual(state().cursors, cursorBefore);
      stateAfterScan = fs.readFileSync(manager.paths.state, 'utf8');
      assert.equal(fs.readFileSync(manager.paths.claudeSettings, 'utf8'), originalClaude);
      assert.equal(fs.readFileSync(manager.paths.codexRules, 'utf8'), originalRules);
      mcp.candidate = item;
      return 'Three actual successes and one actual isError outcome produce one eligible mixed-case MCP identity, with deduplicated Codex-only counts and no Claude/shell grant.';
    });
    if (failed()) return;
    await check('actual Cancel preserves MCP config and Approve tool enables only the exact capability in a fresh process', async () => {
      const before = snapshot();
      await approve('cancel-tool', 'Cancel');
      assert.deepEqual(snapshot(), before, 'WITNESS MCP Cancel preserves config, learning, policy and ledger bytes');
      await approve('approve-tool', 'Approve tool');
      await waitFor(() => ledger().pending === null && ledger().receipts.some((entry) => entry.action === 'approve'),
        'WITNESS actual MCP Approve tool records a completed config change');
      const view = inspect(); assert.equal(view.supported, true, view.reason); assert.equal(view.explicitApprovalMode, 'approve');
      approvedReceipt = config.listCodexMcpApprovals(managerOptions).find((entry) => entry.server === serverName && entry.tool === tool && entry.undoable);
      assert.ok(approvedReceipt); assert.equal(approvedReceipt.beforeApproval.exists, false);
      const allowed = await runRuntime('exact-tool-reused', tool, { shouldFail: false, marker: 'different-after-review-arguments' }, 'decline',
        { approvals: 0, executed: 1, status: 'completed' });
      const expected = JSON.parse(JSON.stringify(initialUserConfig));
      expected.mcp_servers[serverName].tools = { ProbeCase: { approval_mode: 'approve' } };
      assert.deepEqual(allowed.nativeUserConfig, expected, 'WITNESS native MCP writer changes only the exact per-tool approval mode');
      await runRuntime('neighbor-still-prompts', 'NeighborCase', { shouldFail: false, marker: 'neighbor' }, 'decline',
        { approvals: 1, executed: 0, status: 'failed' });
      assert.ok(fs.readFileSync(configPath, 'utf8').includes('# User-owned MCP fixture note must survive reviewed writes.'));
      mcp.approvedReceipt = approvedReceipt;
      return 'Actual Cancel is byte-preserving. Approve tool writes only the exact mixed-case tool setting; fresh calls with different arguments skip approval, while the neighboring tool still prompts.';
    });
    if (failed()) return;
    await check('actual Undo saved tool approval restores the prior MCP config and fresh approval prompt', async () => {
      await action('undo-tool', { expectedDescription: 'Undo saved tool approval', expectedTitle: 'Undo this Codex MCP approval?',
        expectedDecision: 'Undo approval', expectedDetailIncludes: ['Restore the previous per-tool setting: no explicit override.',
          'Other server settings and project trust are preserved.', 'A changed configuration is left for review.', 'Restart Codex afterward.'] });
      await waitFor(() => ledger().pending === null && ledger().receipts.some((entry) => entry.action === 'restore' && entry.restores === approvedReceipt.id),
        'WITNESS actual MCP Undo records the restored approval');
      const view = inspect(); assert.equal(view.explicitApprovalMode, null); assert.equal(view.effectiveApprovalMode, 'prompt');
      const undone = await runRuntime('undone-tool-prompts', tool, { shouldFail: false, marker: 'after-undo' }, 'decline',
        { approvals: 1, executed: 0, status: 'failed' });
      assert.deepEqual(undone.nativeUserConfig, initialUserConfig, 'Undo must restore original semantics including absent tools tables');
      assert.ok(config.listCodexMcpApprovals(managerOptions).find((entry) => entry.id === approvedReceipt.id)?.restored);
      return 'Actual Undo restores the previous native config semantics and absent per-tool tables; a new Codex process again requests approval for the original tool.';
    });
    if (failed()) return;
    await check('actual MCP confirmation rejects a config edited while the full review modal is open', async () => {
      let before;
      await approve('stale-tool', 'Approve tool', { expectedWarning: 'Codex MCP approval selection changed after review' }, async () => {
        fs.appendFileSync(configPath, '# User edit while exact MCP approval confirmation was open.\n');
        before = snapshot();
      });
      assert.deepEqual(snapshot(), before, 'WITNESS stale MCP review cannot overwrite a concurrent config edit or create a receipt');
      assert.equal(inspect().explicitApprovalMode, null);
      return 'The full actual approval dialog precedes a concurrent config edit; confirmation displays stale-selection refusal and preserves every captured byte.';
    });
    if (failed()) return;
    await check('actual Resolve change cancels an unwritten MCP intent and records an already written exact intent without retrying', async () => {
      const plan = () => manager.planCodexMcp({ key, expectedCandidateFingerprint: manager.codexMcpInventory().candidates.find((entry) => entry.key === key).fingerprint });
      const request = (value) => ({ key, expectedCandidateFingerprint: value.candidate.fingerprint, expectedConfigFingerprint: value.proposal.fingerprint });
      const beforeUnwritten = fs.readFileSync(configPath);
      const receiptsBefore = ledger().receipts.length;
      const first = plan();
      let beforeInterruptions = 0;
      const beforeWriter = createAutoLearnManager({ ...managerOptions, codexMcpConfigOptions: { afterIntent() {
        beforeInterruptions++; throw new Error('ACOLYTE_MCP_BEFORE_WRITE');
      } } });
      assert.throws(() => beforeWriter.approveCodexMcp(request(first)), /ACOLYTE_MCP_BEFORE_WRITE/);
      assert.equal(beforeInterruptions, 1); assert.ok(ledger().pending);
      assert.deepEqual(fs.readFileSync(configPath), beforeUnwritten);
      await recover('recover-unwritten');
      await waitFor(() => ledger().pending === null, 'WITNESS actual MCP Resolve cancels the unwritten intent');
      assert.equal(ledger().receipts.length, receiptsBefore); assert.deepEqual(fs.readFileSync(configPath), beforeUnwritten);
      const second = plan();
      let afterInterruptions = 0;
      const afterWriter = createAutoLearnManager({ ...managerOptions, codexMcpConfigOptions: { afterWrite() {
        afterInterruptions++; throw new Error('ACOLYTE_MCP_AFTER_WRITE');
      } } });
      assert.throws(() => afterWriter.approveCodexMcp(request(second)), /ACOLYTE_MCP_AFTER_WRITE/);
      assert.equal(afterInterruptions, 1);
      const written = fs.readFileSync(configPath); const pending = ledger().pending;
      assert.ok(pending); assert.notDeepEqual(written, beforeUnwritten); assert.equal(inspect().explicitApprovalMode, 'approve');
      await recover('recover-written');
      await waitFor(() => ledger().pending === null && ledger().receipts.some((entry) => entry.id === pending.id),
        'WITNESS actual MCP Resolve records the written exact intent');
      assert.deepEqual(fs.readFileSync(configPath), written, 'recovery must not retry or reformat the already completed config write');
      assert.equal(ledger().receipts.length, receiptsBefore + 1);
      assert.equal(fs.readFileSync(manager.paths.state, 'utf8'), stateAfterScan);
      assert.equal(fs.readFileSync(manager.paths.claudeSettings, 'utf8'), originalClaude);
      assert.equal(fs.readFileSync(manager.paths.codexRules, 'utf8'), originalRules);
      if (process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT === 'custom-override') assert.equal(fs.existsSync(path.join(home, '.codex')), false);
      mcp.finalLedger = ledger(); mcp.finalSnapshot = snapshot();
      return 'Actual Resolve cancels the before-write intent without editing config; a second actual Resolve records the exact already-written change without retrying it. Policy and learner files remain untouched.';
    });
  } finally {
    mcp.status = failed() ? 'failed' : 'passed';
    const artifacts = ['extension.js', 'package.json', 'codexFeaturesUi.js', 'autoLearnWorkerRunner.js',
      'src/auto-learn-manager.js', 'src/auto-learn-worker.js', 'src/history-adapters.js', 'src/tool-learn.js',
      'src/codex-mcp-config.js', 'src/codex-mcp-review.js'];
    const artifactHashes = Object.fromEntries(artifacts.filter((file) => fs.existsSync(path.join(extensionDir, file)))
      .map((file) => [file, hash(fs.readFileSync(path.join(extensionDir, file)))]));
    fs.writeFileSync(reportPath, JSON.stringify({ vscodeVersion: vscode.version, nodeVersion: process.version, extensionDir,
      home, codexHome, codexLayout: process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT, workspace,
      results, artifactHashes, mcp }, null, 2) + '\n');
    writeProgress(failed() ? 'review-runtime-failed' : 'codex-mcp-complete', {
      detail: failed() ? results.find((item) => item.verdict === 'FAIL').detail : 'Focused exact MCP UI acceptance passed.' });
    if (failed()) throw new Error('Focused MCP acceptance failed; see acceptance.json');
  }
};
