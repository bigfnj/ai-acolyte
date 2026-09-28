'use strict';

// Actual editor UI and fresh Codex processes, with policy fixtures confined to
// the launcher-owned profile. No vscode mocks, provider credentials or inference.
const vscode = require('vscode');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const { createHash } = require('node:crypto');
const { spawnSync } = require('node:child_process');

exports.run = async function run() {
  assert.equal(process.env.ACOLYTE_ACCEPTANCE_APPROVALS_ONLY, '1');
  const home = process.env.ACOLYTE_ACCEPTANCE_HOME;
  const reportPath = process.env.ACOLYTE_ACCEPTANCE_REPORT;
  const root = path.dirname(reportPath);
  const codexHome = process.env.ACOLYTE_ACCEPTANCE_CODEX_HOME;
  const extensionDir = process.env.ACOLYTE_ACCEPTANCE_EXTENSION;
  const progress = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
  const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
  const runtimeWorkspace = path.join(root, 'runtime-workspace');
  const normalized = (file) => path.resolve(file).toLowerCase();
  const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
  const suffix = hash(root).slice(0, 10);
  const results = [];
  const approvals = { steps: [], cases: [], policyChecks: [],
    boundary: 'Actual dashboard pickers and confirmation dialogs; literal policy fixtures; fresh real Codex processes in a sibling workspace with a scripted loopback responder. No inference or credentials. A test hook interrupts only the isolated recovery fixture.' };
  const writeProgress = (phase, details = {}) => {
    assert.equal(normalized(path.dirname(progress)), normalized(root));
    fs.writeFileSync(progress + '.tmp', JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(progress + '.tmp', progress);
  };
  const waitFor = async (predicate, label, timeout = 20000) => {
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
  const declaration = (pattern, decision = 'allow') => `prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = ${JSON.stringify(decision)})`;
  const collect = (base) => fs.existsSync(base) ? fs.readdirSync(base, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry) => {
      const file = path.join(base, entry.name);
      assert.ok(!entry.isSymbolicLink(), 'fixture snapshot must not follow links');
      return entry.isDirectory() ? collect(file) : entry.isFile() && !entry.name.endsWith('.lock') ? [file] : [];
    }) : [];
  // Codex sessions/config may change during runtime checks. All policy, learning,
  // claims, backup and instruction bytes are included in UI-only snapshots.
  const snapshot = () => Object.fromEntries([
    ...collect(path.join(home, '.claude')), ...collect(path.join(home, '.ai-acolyte')),
    ...collect(path.join(codexHome, 'rules')), ...collect(path.join(workspace, '.codex')),
    ...['AGENTS.md', 'AGENTS.override.md'].map((name) => path.join(codexHome, name)).filter(fs.existsSync),
  ].sort().map((file) => [file, hash(fs.readFileSync(file))]));
  const action = async (caseId, details, whileModal) => {
    const ackPath = path.join(root, `codex-approval-${caseId}.json`);
    const readyPath = path.join(root, `codex-approval-${caseId}-ready.json`);
    const continuePath = path.join(root, `codex-approval-${caseId}-continue.json`);
    assert.equal(fs.existsSync(ackPath), false);
    writeProgress('codex-approval-action', { caseId, suffix, ...details, ackPath,
      ...(whileModal ? { readyPath, continuePath } : {}) });
    if (whileModal) {
      await waitFor(() => fs.existsSync(readyPath), `${caseId} actual confirmation is open`, 60000);
      const ready = JSON.parse(fs.readFileSync(readyPath, 'utf8'));
      assert.equal(ready.caseId, caseId);
      assert.equal(ready.status, 'modal-open');
      await whileModal();
      fs.writeFileSync(continuePath, JSON.stringify({ caseId, status: 'continue' }) + '\n');
    }
    const ack = await waitFor(() => fs.existsSync(ackPath) && JSON.parse(fs.readFileSync(ackPath, 'utf8')), `${caseId} UI acknowledgement`, 60000);
    assert.equal(ack.caseId, caseId);
    assert.equal(ack.status, 'passed', ack.error || 'actual reviewed-rule UI failed');
    assert.equal(ack.clicked, details.kind === 'project-import' ? 'importCodexRules' : 'reviewCodexApprovals');
    approvals.steps.push(ack);
    return ack;
  };
  const ask = (caseId, plan, decision, extra = {}, whileModal) => action(caseId, {
    kind: plan.kind, expectedLabel: JSON.stringify(plan.target.pattern), expectedPath: plan.source.path,
    expectedDescription: `${plan.target.decision} · ${plan.kind === 'project-import' ? 'project import' : 'wider approval'}`,
    expectedTitle: 'Apply this reviewed Codex rule change?', expectedDecision: decision,
    expectedDetailIncludes: [plan.source.path, plan.source.text, destination, plan.target.text,
      'The source remains unchanged.', 'This applies across workspaces.', 'Restart Codex',
      ...(plan.dependencies || []).map((item) => item.text)], ...extra,
  }, whileModal);
  const userRules = path.join(codexHome, 'rules');
  const destination = path.join(userRules, 'ai-acolyte-reviewed.rules');
  const stored = path.join(userRules, `acolyte-stored-${suffix}.rules`);
  const project = path.join(workspace, '.codex', 'rules', `acolyte-project-${suffix}.rules`);
  const promptFile = path.join(workspace, '.codex', 'rules', `acolyte-restriction-${suffix}.rules`);
  const initialDestination = '# User-owned reviewed policy notes. Keep these bytes.\n';
  let manager;
  let managerOptions;
  let createAutoLearnManager;
  let parseCodexRules;
  let runRuntime;
  let checkPolicy;
  let stateBefore;
  try {
    await check('the reviewed-rules UI activates in the selected isolated extension and profile', async () => {
      const extension = vscode.extensions.getExtension('local.permission-wildcarding');
      assert.ok(extension);
      assert.equal(normalized(extension.extensionPath), normalized(extensionDir));
      await extension.activate();
      assert.ok(extension.isActive);
      assert.equal(vscode.workspace.getConfiguration('permissionWildcarding').get('autoLearn.enabled'), false);
      ({ createAutoLearnManager } = require(path.join(extensionDir, 'src/auto-learn-manager.js')));
      ({ parseCodexRules } = require(path.join(extensionDir, 'src/codex-rule-inventory.js')));
      managerOptions = { home, codexHome, workspaceRoot: workspace,
        codexRulesPath: path.join(userRules, 'permission-wildcarding.rules'), mode: 'recommend' };
      manager = createAutoLearnManager(managerOptions);
      const { commandLaunch } = require(path.join(extensionDir, 'src/exec-resolve.js'));
      checkPolicy = (name, argv, decision) => {
        const files = fs.readdirSync(userRules).filter((file) => file.endsWith('.rules')).sort().map((file) => path.join(userRules, file));
        const launch = commandLaunch('codex', ['execpolicy', 'check', ...files.flatMap((file) => ['--rules', file]), '--', ...argv]);
        const checked = spawnSync(launch.file, launch.args, { ...launch.options, cwd: runtimeWorkspace,
          env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30000 });
        assert.ifError(checked.error); assert.equal(checked.status, 0, checked.stderr);
        const value = JSON.parse(checked.stdout);
        assert.equal(value.decision || 'none', decision, `${name}: actual explicit execpolicy decision`);
        if (decision === 'allow') assert.ok(value.matchedRules.length > 0);
        else assert.equal(value.matchedRules.length, 0);
        approvals.policyChecks.push({ name, argv, files, value });
      };
      stateBefore = fs.readFileSync(manager.paths.state, 'utf8');
      fs.mkdirSync(runtimeWorkspace);
      const git = spawnSync('git', ['init', runtimeWorkspace], { windowsHide: true, encoding: 'utf8', timeout: 10000 });
      assert.ifError(git.error); assert.equal(git.status, 0, git.stderr);
      const gitWitness = `acolyte-reviewed-${suffix}.txt`;
      fs.writeFileSync(path.join(runtimeWorkspace, gitWitness), 'Owned untracked runtime witness.\n');
      const { createRuntimeContext, runtimeCase, assertAllowed, assertDeclined } = require('../check-codex-runtime.js');
      runRuntime = async (name, commandName, argument, witness, allow) => {
        const context = createRuntimeContext({ extensionDir, home, codexHome, workspace: runtimeWorkspace, commandName,
          shellWitness: witness, approvalDecision: 'decline', customLayout: process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT === 'custom-override',
          instructionWitnesses: { user: 'Keep this user-owned line.', gate: 'Fixture standing order', shadowed: 'This base file must stay byte-identical.' } });
        let value;
        try { value = await runtimeCase(context, name, argument, false); }
        catch (error) { if (error.runtimeEvidence) approvals.cases.push(error.runtimeEvidence); throw error; }
        approvals.cases.push(value);
        if (allow) assertAllowed(value); else assertDeclined(value);
        assert.equal(fs.readFileSync(manager.paths.state, 'utf8'), stateBefore, 'disabled background scans must preserve learner state during runtime checks');
        return value;
      };
      approvals.gitWitness = gitWitness;
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
      return `VS Code ${vscode.version}; host ${process.version}; runtime workspace is separate from the project source workspace.`;
    });
    if (failed()) return;
    await check('actual stored-approval Cancel preserves bytes and Apply adds a reusable user rule consumed by fresh Codex', async () => {
      const original = '# Original approval and its inline tests stay untouched.\n'
        + 'prefix_rule(pattern = ["git","status","--short"], decision = "allow", match = ["git status --short"], not_match = ["git diff"])\n';
      fs.writeFileSync(stored, original);
      fs.writeFileSync(destination, initialDestination);
      const plan = manager.codexApprovalInventory('stored-widening').plans.find((item) => JSON.stringify(item.target.pattern) === '["git","status"]');
      assert.ok(plan, 'literal stored git status approval must offer a shorter safe prefix');
      checkPolicy('stored-before-review', ['git', 'status', '--porcelain'], 'none');
      // Codex's built-in read-only assessment already permits git status. The
      // explicit checker proves rule coverage; this runtime baseline is retained
      // so a successful call is never misreported as a newly suppressed prompt.
      await runRuntime('stored-before-review-builtin-allow', 'git', 'status --porcelain', approvals.gitWitness, true);
      const before = snapshot();
      await ask('widen-cancel', plan, 'Cancel');
      assert.deepEqual(snapshot(), before, 'WITNESS reviewed approval Cancel preserves policy, learner, claims and backup bytes');
      await ask('widen-apply', plan, 'Apply change');
      await waitFor(() => fs.readFileSync(destination, 'utf8').includes(plan.target.text)
        && fs.existsSync(manager.paths.codexRemovals)
        && JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8')).pending === null,
      'WITNESS actual reviewed Apply writes the wider user prefix');
      assert.equal(fs.readFileSync(stored, 'utf8'), original, 'stored approval source and inline tests changed');
      assert.equal(fs.readFileSync(destination, 'utf8'), initialDestination + plan.target.text + '\n');
      const record = JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8'));
      assert.equal(record.pending, null); assert.equal(record.lastApproval.proposalKind, 'stored-widening');
      assert.equal(record.lastApproval.addedCount, 1);
      checkPolicy('stored-after-review', ['git', 'status', '--porcelain'], 'allow');
      await runRuntime('stored-after-review', 'git', 'status --porcelain', approvals.gitWitness, true);
      checkPolicy('stored-neighbor', ['git', 'diff', '--stat'], 'none');
      return 'Actual Cancel preserves bytes; Apply adds only git status to the user destination. Actual explicit policy changes from no match to allow and excludes git diff. Fresh Codex succeeds before and after because its built-in read-only assessment already permits git status; no prompt-reduction claim is made for that command.';
    });
    if (failed()) return;
    await check('actual project import preserves source files and carries an overlapping prompt into fresh cross-workspace Codex', async () => {
      const command = `acolyte-import-${suffix}.cmd`;
      const witness = `acolyte-import-witness-${suffix}`;
      fs.writeFileSync(path.join(runtimeWorkspace, command), `@echo off\r\necho ${witness}\r\n`);
      fs.mkdirSync(path.dirname(project), { recursive: true });
      const allow = declaration([command]);
      const prompt = declaration([command, '--restricted'], 'prompt');
      const original = '# Keep this authored project approval.\n' + allow + '\n';
      const restricted = '# Keep this authored project restriction.\n' + prompt + '\n';
      fs.writeFileSync(project, original); fs.writeFileSync(promptFile, restricted);
      const plan = manager.codexApprovalInventory('project-import').plans.find((item) => item.target.pattern[0] === command && item.target.decision === 'allow');
      assert.ok(plan); assert.equal(plan.autoSafe, false); assert.equal(plan.dependencies.length, 1);
      assert.equal(plan.dependencies[0].text, prompt);
      await runRuntime('project-before-import', command, '--allowed', witness, false);
      const before = snapshot();
      await ask('import-cancel', plan, 'Cancel');
      assert.deepEqual(snapshot(), before, 'WITNESS project import Cancel preserves every policy and learner byte');
      const destinationBefore = fs.readFileSync(destination, 'utf8');
      await ask('import-apply', plan, 'Apply change');
      await waitFor(() => fs.readFileSync(destination, 'utf8').includes(allow)
        && JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8')).pending === null,
      'WITNESS actual import writes selected user allow');
      const after = fs.readFileSync(destination, 'utf8');
      assert.equal(after, destinationBefore + prompt + '\n' + allow + '\n', 'WITNESS import must write overlapping restrictive dependency with the allow');
      assert.equal(fs.readFileSync(project, 'utf8'), original); assert.equal(fs.readFileSync(promptFile, 'utf8'), restricted);
      const parsed = parseCodexRules(after); assert.ok(parsed.supported);
      assert.ok(parsed.rules.some((item) => item.decision === 'prompt' && item.pattern[0] === command));
      await runRuntime('project-after-import', command, '--allowed', witness, true);
      await runRuntime('project-restriction', command, '--restricted', witness, false);
      return 'The exact project allow and overlapping prompt are copied together into user scope; both original sources remain byte-identical; a fresh sibling-workspace Codex process allows only the unrestricted call.';
    });
    if (failed()) return;
    await check('unsupported reviewed-rule sources remain read-only through the actual picker', async () => {
      const file = path.join(userRules, `acolyte-computed-${suffix}.rules`);
      const content = 'fixture_command = "git"\nprefix_rule(pattern = [fixture_command], decision = "allow")\n';
      fs.writeFileSync(file, content);
      const view = manager.codexApprovalInventory('stored-widening');
      const unsupported = view.files.find((item) => normalized(item.path) === normalized(file));
      assert.equal(unsupported.supported, false); assert.ok(unsupported.reason);
      const before = snapshot();
      await action('inspect-unsupported', { kind: 'stored-widening', expectedLabel: file, expectedPath: file,
        expectedDescription: 'Read-only', expectedWarning: unsupported.reason, expectedDecision: null });
      assert.deepEqual(snapshot(), before, 'WITNESS unsupported reviewed selection cannot write policy or state');
      assert.equal(fs.readFileSync(file, 'utf8'), content);
      fs.unlinkSync(file);
      return 'The actual read-only row displays the computed-input reason and leaves policy/state bytes unchanged.';
    });
    if (failed()) return;
    await check('a source edited while its actual review modal is open is refused without overwriting the edit', async () => {
      const file = path.join(userRules, `acolyte-stale-${suffix}.rules`);
      fs.writeFileSync(file, '# Stale review fixture.\n' + declaration(['git', 'rev-parse', '--show-toplevel']) + '\n');
      const plan = manager.codexApprovalInventory('stored-widening').plans.find((item) => JSON.stringify(item.target.pattern) === '["git","rev-parse"]');
      assert.ok(plan);
      let before;
      await ask('stale-apply', plan, 'Apply change', { expectedWarning: 'Selected Codex proposal is stale or unavailable' }, async () => {
        fs.appendFileSync(file, '# User edit made after the full confirmation opened.\n');
        before = snapshot();
      });
      assert.deepEqual(snapshot(), before, 'WITNESS stale approval must preserve the concurrent source edit and all policy/state bytes');
      assert.equal(fs.readFileSync(destination, 'utf8').includes(declaration(['git', 'rev-parse'])), false);
      return 'The actual confirmation was open before the source changed; Apply displayed stale-proposal refusal and wrote nothing.';
    });
    if (failed()) return;
    await check('actual Finish change resumes precisely the interrupted reviewed-rule intent', async () => {
      const file = path.join(userRules, `acolyte-recovery-${suffix}.rules`);
      const original = '# Recovery source remains untouched.\n' + declaration(['git', 'ls-tree', '--name-only']) + '\n';
      fs.writeFileSync(file, original);
      const plan = manager.codexApprovalInventory('stored-widening').plans.find((item) => JSON.stringify(item.target.pattern) === '["git","ls-tree"]');
      assert.ok(plan);
      let interruptions = 0;
      const interrupted = createAutoLearnManager({ ...managerOptions, testHooks: { afterPolicyWrite(event) {
        if (event.kind !== 'codex-approval') return;
        assert.equal(normalized(event.path), normalized(destination)); interruptions++;
        throw new Error('ACOLYTE_NATIVE_REVIEWED_INTERRUPTION');
      } } });
      assert.throws(() => interrupted.approveCodexRules({ kind: plan.kind, id: plan.id }), /ACOLYTE_NATIVE_REVIEWED_INTERRUPTION/);
      assert.equal(interruptions, 1);
      const pending = JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8'));
      assert.equal(pending.pending.kind, 'approval');
      assert.ok(fs.readFileSync(destination, 'utf8').includes(plan.target.text));
      const policyBefore = fs.readFileSync(destination, 'utf8');
      await action('finish-interrupted', { kind: 'stored-widening', expectedPath: file, expectedLabel: null,
        expectedTitle: 'Finish interrupted Codex reviewed change?', expectedDecision: 'Finish change',
        expectedDetailIncludes: ['Finish the exact rule change you already confirmed.', 'Concurrent edits are preserved.', 'Restart Codex'] });
      await waitFor(() => JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8')).pending === null,
        'WITNESS actual Finish change clears the durable reviewed intent');
      const complete = JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8'));
      assert.deepEqual(complete.lastApproval, pending.pending);
      assert.equal(fs.readFileSync(destination, 'utf8'), policyBefore, 'recovery must not duplicate the already written rule');
      assert.equal(fs.readFileSync(file, 'utf8'), original);
      assert.equal(fs.readFileSync(manager.paths.state, 'utf8'), stateBefore);
      if (process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT === 'custom-override') assert.equal(fs.existsSync(path.join(home, '.codex')), false);
      approvals.destination = destination; approvals.record = manager.paths.codexRemovals;
      approvals.finalSnapshot = snapshot();
      return 'An owned after-policy-write interruption leaves an exact durable intent; actual Finish change completes it without duplicating policy or changing original sources/learner state.';
    });
  } finally {
    approvals.status = failed() ? 'failed' : 'passed';
    const artifacts = ['extension.js', 'package.json', 'codexFeaturesUi.js', 'autoLearnWorkerRunner.js',
      'src/auto-learn-manager.js', 'src/auto-learn-worker.js', 'src/codex-rule-store.js', 'src/codex-reviewed-plans.js',
      'src/codex-approval-plans.js', 'src/codex-rule-inventory.js', 'src/codex-policy.js'];
    const artifactHashes = Object.fromEntries(artifacts.filter((file) => fs.existsSync(path.join(extensionDir, file)))
      .map((file) => [file, hash(fs.readFileSync(path.join(extensionDir, file)))]));
    fs.writeFileSync(reportPath, JSON.stringify({ vscodeVersion: vscode.version, nodeVersion: process.version, extensionDir,
      home, codexHome, codexLayout: process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT, workspace, runtimeWorkspace,
      results, artifactHashes, approvals }, null, 2) + '\n');
    writeProgress(failed() ? 'review-runtime-failed' : 'codex-approvals-complete', {
      detail: failed() ? results.find((item) => item.verdict === 'FAIL').detail : 'Focused reviewed-rule UI acceptance passed.' });
    if (failed()) throw new Error('Focused reviewed-rule acceptance failed; see acceptance.json');
  }
};
