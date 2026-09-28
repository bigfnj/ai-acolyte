'use strict';

// Loaded in the actual extension host by the test entry point or isolated helper.
// Never replace vscode, os, fs, or child_process with mocks in this runner.
const vscode = require('vscode');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

exports.run = async function run() {
  const home = process.env.ACOLYTE_ACCEPTANCE_HOME;
  const report = process.env.ACOLYTE_ACCEPTANCE_REPORT;
  const extensionDir = process.env.ACOLYTE_ACCEPTANCE_EXTENSION;
  const codexHome = process.env.ACOLYTE_ACCEPTANCE_CODEX_HOME;
  const codexLayout = process.env.ACOLYTE_ACCEPTANCE_CODEX_LAYOUT;
  assert.ok(home && report && extensionDir && codexHome && codexLayout, 'run this through scripts/drive-vscode.js');
  const override = codexLayout === 'custom-override';
  const codexInstructions = path.join(codexHome, override ? 'AGENTS.override.md' : 'AGENTS.md');
  const results = [];
  const reviewRuntime = process.env.ACOLYTE_ACCEPTANCE_REVIEW_RUNTIME === '1'
    ? { boundary: 'Actual Codex processes and session history, real native Review and diagnostic UI, scripted loopback responses; no provider inference or credentials.', cases: [], diagnostics: [], dashboardActions: [] }
    : null;
  const dashboardUi = process.env.ACOLYTE_ACCEPTANCE_DASHBOARD_UI === '1'
    ? { boundary: 'Actual dashboard controls and confirmation dialogs; Codex-only partial instruction blocks are a staged fixture.', steps: [] }
    : null;
  const codexPrune = process.env.ACOLYTE_ACCEPTANCE_CODEX_PRUNE === '1'
    ? { boundary: 'Actual dashboard inventory, selection, removal and recovery dialogs with independent file/state assertions. Literal rules and successful learner observations are staged in the isolated profile; a test hook interrupts the recovery fixture after the policy write.', steps: [] }
    : null;
  const codexRestore = process.env.ACOLYTE_ACCEPTANCE_CODEX_RESTORE === '1'
    ? { boundary: 'Actual dashboard restore dialogs and real manager writes; missing and interrupted policy are staged only in the owned profile.', steps: [] } : null;
  const codexDerived = process.env.ACOLYTE_ACCEPTANCE_CODEX_DERIVED === '1'
    ? { boundary: 'Actual derived-guidance review and fresh Codex instruction loading. Managed policy and source-specific successful counts are staged; no historical approval-count claim.', steps: [], cases: [] } : null;
  const followups = { codexRestoreExpected: !!codexRestore, codexDerivedExpected: !!codexDerived };
  const writeProgress = (phase, details = {}) => {
    const file = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
    assert.ok(file && path.resolve(path.dirname(file)) === path.resolve(path.dirname(report)));
    fs.writeFileSync(file + '.tmp', JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    fs.renameSync(file + '.tmp', file);
  };
  const actionAck = async (caseId, kind, details) => {
    const ackPath = path.join(path.dirname(report), `${kind}-${caseId}.json`);
    assert.equal(fs.existsSync(ackPath), false, `${caseId}: stale UI acknowledgement exists`);
    writeProgress(`${kind}-action`, { caseId, ...details, ackPath });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) {
      if (fs.existsSync(ackPath)) {
        const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
        assert.equal(ack.caseId, caseId);
        assert.equal(ack.status, 'passed', `${caseId}: real UI failed: ${ack.error || ack.detail || 'see renderer evidence'}`);
        return ack;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`${caseId}: real UI acknowledgement did not arrive within 60 seconds`);
  };
  const check = async (name, task) => {
    try { results.push({ verdict: 'PASS', name, detail: await task() || '' }); }
    catch (error) { results.push({ verdict: 'FAIL', name, detail: error.stack || error.message }); }
  };
  const waitFor = async (condition, label) => {
    const deadline = Date.now() + 15000;
    let last;
    do {
      try { const result = condition(); if (result) return result; } catch (error) { last = error; }
      await new Promise((resolve) => setTimeout(resolve, 100));
    } while (Date.now() < deadline);
    throw new Error(`timed out waiting for ${label}${last ? `: ${last.message}` : ''}`);
  };
  const state = () => {
    const dir = path.join(home, '.claude', 'wildcarding');
    const files = fs.readdirSync(dir).filter((f) => /^auto-learn-state.*\.json$/.test(f));
    assert.equal(files.length, 1, 'expected one workspace-partitioned learner state');
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  };
  const candidate = (value) => Object.values(value.candidates || {}).find((item) => item.prefix.join(' ') === 'git status');
  const invoke = (name) => vscode.commands.executeCommand(`permission-wildcarding.${name}`);
  const ownInstructions = '# Fixture user instructions\nKeep this user-owned line.\n';
  const instructionFiles = [path.join(home, '.claude', 'CLAUDE.md'), codexInstructions];
  const rules = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
  const { commandLaunch } = require(path.join(extensionDir, 'src', 'exec-resolve.js'));
  const policy = (argv) => {
    const launch = commandLaunch('codex', ['execpolicy', 'check', '--rules', rules, '--', ...argv]);
    const result = spawnSync(launch.file, launch.args, { ...launch.options,
      cwd: home, env: process.env, encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.ifError(result.error);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    return JSON.parse(result.stdout);
  };
  const assertInactiveCodexPaths = () => {
    if (!override) return;
    assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'extension created the unused default ~/.codex directory');
    assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'),
      '# Inactive base instructions\nThis base file must stay byte-identical.\n',
      'inactive AGENTS.md retained stale managed blocks or changed its user-owned text');
  };

  try {
    await check('the real extension host activates the selected extension in the isolated home', async () => {
      assert.equal(os.homedir(), home, 'extension host escaped the isolated home');
      assert.equal(process.env.CODEX_HOME, codexHome);
      const extension = vscode.extensions.getExtension('local.permission-wildcarding');
      assert.ok(extension, 'development extension was not discovered');
      assert.equal(path.resolve(extension.extensionPath).toLowerCase(), path.resolve(extensionDir).toLowerCase());
      assert.equal(extension.packageJSON.version, process.env.ACOLYTE_ACCEPTANCE_VERSION);
      await extension.activate();
      assert.equal(extension.isActive, true);
      const registered = await vscode.commands.getCommands(true);
      for (const command of ['autoLearnScan', 'autoLearnApplySafe', 'autoLearnUndo', 'toggleGuidance', 'toggleGates']) {
        assert.ok(registered.includes(`permission-wildcarding.${command}`), `missing actual VS Code command ${command}`);
      }
      return `${extension.extensionPath}; VS Code ${vscode.version}; ${process.version}`;
    });
    await check(`real configuration events install and remove independent guidance and gates in ${path.basename(codexInstructions)} and CLAUDE.md`, async () => {
      const guidance = '<!-- BEGIN permission-wildcarding: shell style (managed) -->';
      const gates = '<!-- BEGIN permission-wildcarding: memory gates (managed) -->';
      const matches = (guidanceOn, gatesOn) => {
        assertInactiveCodexPaths();
        return instructionFiles.every((file) => {
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(text.startsWith(ownInstructions), `user text changed: ${file}`);
        return text.includes(guidance) === guidanceOn && text.includes(gates) === gatesOn;
        });
      };
      await waitFor(() => matches(false, false), 'initial disabled settings remove any stale blocks from the inactive base');
      const config = vscode.workspace.getConfiguration('permissionWildcarding');
      await config.update('guidance.enabled', true, vscode.ConfigurationTarget.Global);
      await waitFor(() => matches(true, false), 'guidance on in both instruction files');
      await config.update('gates.enabled', true, vscode.ConfigurationTarget.Global);
      await waitFor(() => matches(true, true), 'memory gates on in both instruction files');
      for (const file of instructionFiles) assert.ok(fs.readFileSync(file, 'utf8').includes('Fixture standing order'));
      await config.update('guidance.enabled', false, vscode.ConfigurationTarget.Global);
      await waitFor(() => matches(false, true), 'guidance off while gates stay on');
      await config.update('gates.enabled', false, vscode.ConfigurationTarget.Global);
      await waitFor(() => matches(false, false), 'both managed blocks removed');
      for (const file of instructionFiles) assert.equal(fs.readFileSync(file, 'utf8'), ownInstructions);
      assertInactiveCodexPaths();
      return `Actual configuration notifications drove ${codexInstructions}; precompiled gate body and user text preserved` +
        (override ? '; initial OFF settings removed only stale blocks from inactive AGENTS.md' : '');
    });
    await check('real Scan Now rebuilds legacy Codex evidence while preserving the prior grant and working undo', async () => {
      const fixture = JSON.parse(fs.readFileSync(path.join(path.dirname(report), 'migration-fixture.json'), 'utf8'));
      assert.equal(state().version, 1, 'precondition: legacy evidence must remain persisted until explicit Scan Now');
      assert.equal(fs.readdirSync(path.join(home, '.claude', 'wildcarding'))
        .some((name) => /^codex-policy-claims\./.test(name)), false,
        'precondition: a legacy transaction must predate shared Codex ownership');
      assert.equal(state().candidates[fixture.key].counts.success, 3);
      assert.equal(fs.readFileSync(rules, 'utf8'), fixture.grantedRules);
      assert.equal(policy(['git', 'ls-files']).decision, 'allow');
      await invoke('autoLearnScan');
      const rebuilt = await waitFor(() => { const value = state(); return value.version === 3 &&
        value.codexEvidenceRebuildPending === false ? value : null; }, 'legacy Codex evidence replay');
      assert.deepEqual(rebuilt.candidates[fixture.key].counts, { success: 0, failed: 0, unknown: 0, total: 0 },
        'pending subprocesses remained false successes after replay');
      assert.equal(rebuilt.legacyCodexEvidence[fixture.key].candidate.counts.success, 3);
      assert.deepEqual(rebuilt.applied, fixture.applied, 'migration changed the prior grant');
      assert.deepEqual(rebuilt.reviewed, fixture.reviewed);
      assert.deepEqual(rebuilt.lastApplication, fixture.lastApplication, 'migration changed the prior undo transaction');
      assert.equal(fs.readFileSync(rules, 'utf8'), fixture.grantedRules, 'migration rewrote existing policy');
      assert.equal(policy(['git', 'ls-files']).decision, 'allow', 'migration revoked the preserved grant');
      assert.equal(candidate(rebuilt), undefined, 'fresh scan fixture became visible before its own command check');
      await invoke('autoLearnScan');
      const rescanned = state();
      assert.deepEqual(rescanned.cursors, rebuilt.cursors, 'unchanged replay changed the persisted history cursor');
      assert.equal(rescanned.candidates[fixture.key].counts.success, 0, 'repeat scan restored stale success counts');
      assert.deepEqual(rescanned.lastApplication, fixture.lastApplication);
      assert.equal(fs.readFileSync(rules, 'utf8'), fixture.grantedRules);
      await invoke('autoLearnUndo');
      await waitFor(() => fs.readFileSync(rules, 'utf8') === fixture.originalRules, 'legacy transaction exact undo');
      const undone = state();
      assert.equal(undone.lastApplication, null);
      assert.equal(undone.applied.codex.includes(fixture.key), false);
      assert.equal(undone.candidates[fixture.key].counts.success, 0);
      assert.equal(undone.legacyCodexEvidence[fixture.key].candidate.counts.success, 3);
      assert.notEqual(policy(['git', 'ls-files']).decision, 'allow');
      assertInactiveCodexPaths();
      return `${fixture.key}: 3 legacy false successes rebuilt to 0; policy and undo preserved, then actual undo restored original bytes`;
    });
    await check('real VS Code commands scan Codex-only history, apply effective policy, and undo it', async () => {
      assert.equal(candidate(state()), undefined, 'precondition: new candidate must be absent before Scan Now');
      fs.copyFileSync(path.join(path.dirname(report), 'fresh-history.jsonl'),
        path.join(codexHome, 'sessions', 'rollout-real-vscode.jsonl'));
      await invoke('autoLearnScan');
      const learned = await waitFor(() => { const value = state(); return candidate(value) ? value : null; }, 'Codex candidate');
      const found = candidate(learned);
      assert.deepEqual(found.sources, ['codex']);
      assert.equal(found.counts.success, 4);
      assert.ok(found.baseAutoSafe);
      assert.ok(!learned.applied.codex.includes(found.key));
      assertInactiveCodexPaths();
      const before = fs.readFileSync(rules, 'utf8');
      await vscode.workspace.getConfiguration('permissionWildcarding')
        .update('autoLearn.enabled', true, vscode.ConfigurationTarget.Global);
      await invoke('autoLearnApplySafe');
      const applied = await waitFor(() => { const value = state(); return value.applied.codex.includes(found.key) ? value : null; }, 'Codex rule apply');
      assertInactiveCodexPaths();
      assert.notEqual(fs.readFileSync(rules, 'utf8'), before);
      assert.ok(applied.lastApplication.targets.some((item) => item.kind === 'codex' && path.resolve(item.path) === path.resolve(rules)),
        'undo transaction did not target the selected CODEX_HOME rules file');
      const allow = policy(['git', 'status', '--short']);
      assert.equal(allow.decision, 'allow');
      assert.ok(allow.matchedRules.length > 0);
      const nearMiss = policy(['git', 'reset', '--hard']);
      assert.notEqual(nearMiss.decision, 'allow');
      assert.equal(nearMiss.matchedRules.length, 0);
      await invoke('autoLearnUndo');
      await waitFor(() => fs.readFileSync(rules, 'utf8') === before, 'exact Codex rule undo');
      const undone = state();
      assert.deepEqual(undone.applied, learned.applied);
      assert.equal(undone.lastApplication, null);
      assert.equal(candidate(undone).counts.success, 4);
      assert.notEqual(policy(['git', 'status', '--short']).decision, 'allow');
      assertInactiveCodexPaths();
      return `${found.key}: 4 successes; ${rules}; allow and near-miss checked by Codex; bytes and candidate state restored`;
    });
    if (reviewRuntime) await check('real Codex history reaches native Review, grants a fresh process, and Undo restores its approval prompt', async () => {
      const progressFile = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
      assert.ok(progressFile, 'review runtime requires the native renderer sidecar progress file');
      assert.equal(path.resolve(path.dirname(progressFile)), path.resolve(path.dirname(report)),
        'review progress must stay inside the isolated acceptance fixture');
      const progress = (phase, details = {}) => {
        const next = `${progressFile}.tmp`;
        fs.writeFileSync(next, JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
        fs.renameSync(next, progressFile);
      };
      try {
        const config = vscode.workspace.getConfiguration('permissionWildcarding');
        await config.update('autoLearn.enabled', false, vscode.ConfigurationTarget.Global);
        const { createRuntimeContext, runtimeCase, rolloutFor, assertAllowed, assertDeclined } =
          require(path.resolve(__dirname, '..', 'check-codex-runtime.js'));
        const { parseCodexJsonl } = require(path.join(extensionDir, 'src', 'history-adapters.js'));
        const workspace = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
        assert.ok(workspace, 'review runtime requires the isolated workspace');
        const suffix = createHash('sha256').update(report).digest('hex').slice(0, 10);
        const commandName = `acolyte-review-${suffix}.cmd`;
        const neighborName = `acolyte-neighbor-${suffix}.cmd`;
        const witness = `acolyte-review-witness-${suffix}`;
        const logName = `review-executions-${suffix}.log`;
        const neighborLogName = `neighbor-executions-${suffix}.log`;
        for (const [name, log] of [[commandName, logName], [neighborName, neighborLogName]]) {
          fs.writeFileSync(path.join(workspace, name),
            `@echo off\r\necho ${witness}\r\necho ${witness}>>"%~dp0${log}"\r\n`);
        }
        const logLines = (name) => fs.existsSync(path.join(workspace, name))
          ? fs.readFileSync(path.join(workspace, name), 'utf8').trim().split(/\r?\n/) : [];
        const contextOptions = { extensionDir, workspace, home, codexHome, commandName,
          shellWitness: witness, customLayout: override,
          instructionWitnesses: { user: 'Keep this user-owned line.', gate: 'Fixture standing order',
            ...(override ? { shadowed: 'This base file must stay byte-identical.' } : {}) } };
        const acceptedContext = createRuntimeContext({ ...contextOptions, approvalDecision: 'accept' });
        const declineContext = createRuntimeContext({ ...contextOptions, approvalDecision: 'decline' });
        const neighborContext = createRuntimeContext({ ...contextOptions, commandName: neighborName, approvalDecision: 'decline' });
        const run = async (context, name, argument) => {
          let result;
          try { result = await runtimeCase(context, name, argument, false); }
          catch (error) {
            if (error.runtimeEvidence) reviewRuntime.cases.push(error.runtimeEvidence);
            throw error;
          }
          const rollout = rolloutFor(codexHome, result.threadId);
          const observations = parseCodexJsonl(fs.readFileSync(rollout, 'utf8'), { file: rollout, platform: process.platform });
          const observedCommand = `${context.commandName} ${argument}`;
          const matching = observations.filter((item) => item.command === observedCommand);
          assert.equal(matching.length, 1, `${name}: real session must contain the command observation`);
          assert.equal(matching[0].source, 'codex');
          result.rollout = { path: rollout, sha256: createHash('sha256').update(fs.readFileSync(rollout)).digest('hex'),
            command: observedCommand, observations: matching.length, status: matching[0].status };
          reviewRuntime.cases.push(result);
          return result;
        };
        const rulesBefore = fs.readFileSync(rules, 'utf8');
        const settingsFile = path.join(home, '.claude', 'settings.json');
        const settingsBefore = fs.readFileSync(settingsFile, 'utf8');
        const buttonStates = (canUndo, enabled = false) => ({
          alScan: true, alReview: enabled, alUndo: canUndo, alWhy: true,
        });
        const readDashboardAck = async (ackPath, caseId) => {
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            if (fs.existsSync(ackPath)) {
              const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
              assert.equal(ack.caseId, caseId);
              assert.equal(ack.status, 'passed', `${caseId}: dashboard action failed: ${ack.error || ack.detail || 'see renderer report'}`);
              return ack;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(`${caseId}: dashboard action acknowledgement did not arrive within 60 seconds`);
        };
        const dashboardAction = async (caseId, action, expectedBeforeButtons, expectedAfterButtons) => {
          const ackPath = path.join(path.dirname(progressFile), `autolearn-${caseId}.json`);
          assert.equal(fs.existsSync(ackPath), false, `${caseId}: stale dashboard action acknowledgement exists`);
          progress('dashboard-autolearn-action', { caseId, action, commandName,
            expectedBeforeButtons, expectedAfterButtons, ackPath });
          const ack = await readDashboardAck(ackPath, caseId);
          assert.equal(ack.clicked, action === 'scan' ? 'alScan' : 'alUndo');
          assert.deepEqual(ack.buttonsBefore, expectedBeforeButtons);
          assert.deepEqual(ack.buttonsAfter, expectedAfterButtons);
          reviewRuntime.dashboardActions.push({ caseId, action, ui: ack });
        };
        const scanActualHistory = async (caseId) => {
          const previousScanAt = state().lastScanAt;
          if (dashboardUi) await dashboardAction(caseId, 'scan', buttonStates(false), buttonStates(false));
          else await invoke('autoLearnScan');
          return waitFor(() => {
            const value = state();
            return value.lastScanAt && value.lastScanAt !== previousScanAt ? value : null;
          }, `${caseId} durable scan completion`);
        };
        const diagnostic = async (caseId, command, expectedArgv, expectedDecision, runtime) => {
          const expectedApprovals = expectedDecision === 'allow' ? 0 : 1;
          const expectedStatus = expectedDecision === 'allow' ? 'completed' : 'declined';
          assert.equal(runtime.approvals, expectedApprovals, `${caseId}: adjacent runtime approval verdict differs`);
          assert.equal(runtime.commandItems[0].status, expectedStatus, `${caseId}: adjacent runtime execution verdict differs`);
          const ackPath = path.join(path.dirname(progressFile), `diagnostic-${caseId}.json`);
          assert.equal(fs.existsSync(ackPath), false, `${caseId}: stale renderer acknowledgement exists`);
          const stateDir = path.join(home, '.claude', 'wildcarding');
          const snapshot = () => {
            const files = [settingsFile, path.join(codexHome, 'config.toml'),
              path.join(workspace, logName), path.join(workspace, neighborLogName),
              ...fs.readdirSync(path.dirname(rules)).filter((name) => name.endsWith('.rules'))
                .map((name) => path.join(path.dirname(rules), name)),
              ...fs.readdirSync(stateDir).filter((name) => /^(?:auto-learn-state.*|(?:claude|codex)-policy-claims.*)\.json$/.test(name))
                .map((name) => path.join(stateDir, name))];
            return Object.fromEntries(files.sort().map((file) => [file, fs.existsSync(file)
              ? createHash('sha256').update(fs.readFileSync(file)).digest('hex') : null]));
          };
          const beforeDiagnostic = snapshot();
          const expectedDisplayedRulesPath = rules.replace(home, '~');
          const expectedBeforeButtons = buttonStates(!!state().lastApplication);
          progress('diagnostic-open', { caseId, command, expectedArgv, expectedDecision,
            expectedRulesPath: rules, expectedDisplayedRulesPath,
            expectedRuntimeApprovals: expectedApprovals, expectedRuntimeStatus: expectedStatus, ackPath,
            viaDashboard: !!dashboardUi, ...(dashboardUi ? { expectedBeforeButtons } : {}) });
          const acknowledgement = (async () => {
            const deadline = Date.now() + 60000;
            while (Date.now() < deadline) {
              if (fs.existsSync(ackPath)) {
                const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
                assert.equal(ack.caseId, caseId, 'renderer acknowledged the wrong diagnostic case');
                assert.equal(ack.status, 'passed', `${caseId}: diagnostic UI failed: ${ack.error || ack.detail || 'see renderer report'}`);
                return ack;
              }
              await new Promise((resolve) => setTimeout(resolve, 100));
            }
            throw new Error(`${caseId}: diagnostic UI acknowledgement did not arrive within 60 seconds`);
          })();
          const [, ack] = await Promise.all([dashboardUi ? Promise.resolve() : invoke('autoLearnWhy'), acknowledgement]);
          if (dashboardUi) {
            assert.equal(ack.clicked, 'alWhy');
            assert.deepEqual(ack.buttonsBefore, expectedBeforeButtons);
            reviewRuntime.dashboardActions.push({ caseId, action: 'why', ui: ack });
          }
          assert.deepEqual(ack.argv, expectedArgv, `${caseId}: diagnostic parsed a different command`);
          assert.equal(ack.observedDecision, expectedDecision, `${caseId}: diagnostic contradicts adjacent runtime verdict`);
          assert.equal(path.resolve(ack.rulePath), path.resolve(rules), `${caseId}: diagnostic checked a different rule file`);
          assert.equal(ack.displayedRulePath, expectedDisplayedRulesPath);
          assert.ok(ack.dialogText.includes('normalized command argv:'), `${caseId}: diagnostic omitted the parsed invocation`);
          assert.ok(ack.dialogText.includes(expectedDisplayedRulesPath), `${caseId}: diagnostic omitted the selected rule path`);
          assert.ok(ack.dialogText.includes('Managed and system-scope Codex policy is not enumerated here'),
            `${caseId}: diagnostic omitted the managed-policy blind spot`);
          assert.ok(ack.dialogText.includes('Session approval state and sandbox restrictions are also outside this check.'),
            `${caseId}: diagnostic omitted the session/sandbox blind spot`);
          assert.deepEqual(snapshot(), beforeDiagnostic,
            `${caseId}: diagnostic changed policy, learner state, runtime configuration, or fixture execution logs`);
          reviewRuntime.diagnostics.push({ caseId, command, expectedArgv, expectedDecision,
            runtime: { name: runtime.name, approvals: runtime.approvals, status: runtime.commandItems[0].status },
            readOnlyHashes: beforeDiagnostic, ui: ack });
          progress('diagnostic-complete', { caseId });
        };
        const before = state();
        const findReviewed = (value) => Object.values(value.candidates || {})
          .find((item) => item.prefix.length === 1 && item.prefix[0].toLowerCase() === commandName);
        assert.equal(findReviewed(before), undefined, 'review command must start without synthetic learner evidence');
        progress('runtime-history-start', { commandName });
        for (let index = 1; index <= 3; index += 1) {
          const result = await run(acceptedContext, `actual-history-${index}`, `learn-${index}`);
          assertAllowed(result, 1);
          assert.equal(result.rollout.status, 'success', 'real individually accepted execution must be learned as success');
          assert.equal(fs.readFileSync(rules, 'utf8'), rulesBefore, 'per-execution acceptance must not amend policy');
        }
        assert.deepEqual(logLines(logName), [witness, witness, witness], 'three actual processes must execute the fixture');
        assert.equal(findReviewed(state()), undefined,
          'background learning populated the runtime candidate before explicit Scan Now');
        if (dashboardUi) {
          await vscode.commands.executeCommand('workbench.action.closeSidebar');
          await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
        }
        await scanActualHistory('actual-history-scan');
        const learned = await waitFor(() => { const value = state(); return findReviewed(value) ? value : null; }, 'actual Codex review candidate');
        const found = findReviewed(learned);
        assert.deepEqual(found.sources, ['codex']);
        assert.equal(found.counts.success, 3);
        assert.equal(found.baseAutoSafe, false, 'custom executable must require manual review');
        assert.equal(learned.reviewed.codex.includes(found.key), false);
        const rescanned = await scanActualHistory('actual-history-rescan');
        assert.deepEqual(findReviewed(rescanned).counts, found.counts, 'repeat scan double-counted actual session history');
        assert.deepEqual(rescanned.observationHashes, learned.observationHashes, 'repeat scan credited duplicate observations');
        assert.equal(fs.readFileSync(rules, 'utf8'), rulesBefore, 'Scan Now must not grant a review-only executable');
        reviewRuntime.candidateKey = found.key;
        reviewRuntime.prefix = found.prefix;
        await config.update('autoLearn.enabled', true, vscode.ConfigurationTarget.Global);
        const reviewAckPath = path.join(path.dirname(progressFile), 'autolearn-actual-history-review.json');
        if (dashboardUi) assert.equal(fs.existsSync(reviewAckPath), false, 'stale dashboard Review acknowledgement exists');
        progress('review-open', { candidateKey: found.key, candidateLabel: found.claudePermission,
          prefix: found.prefix, expectedTarget: 'codex', viaDashboard: !!dashboardUi,
          ...(dashboardUi ? { caseId: 'actual-history-review', expectedBeforeButtons: buttonStates(false, true),
            ackPath: reviewAckPath } : {}) });
        // The separate renderer clicks the real QuickPick checkbox and Grant
        // modal. Await the actual command promise; do not replace any vscode API.
        let reviewTimer;
        try {
          if (dashboardUi) {
            const ack = await readDashboardAck(reviewAckPath, 'actual-history-review');
            assert.equal(ack.clicked, 'alReview');
            assert.deepEqual(ack.buttonsBefore, buttonStates(false, true));
            assert.ok(ack.checkboxChecked && ack.pickerAccepted && ack.grantClicked,
              'dashboard Review requires actual candidate selection and Grant confirmation');
            reviewRuntime.dashboardActions.push({ caseId: 'actual-history-review', action: 'review', ui: ack });
          } else {
            await Promise.race([invoke('autoLearnReview'), new Promise((resolve, reject) => {
              reviewTimer = setTimeout(() => reject(new Error('native Review UI did not complete within 60 seconds')), 60000);
            })]);
          }
        } finally { clearTimeout(reviewTimer); }
        const reviewed = await waitFor(() => { const value = state(); return value.reviewed.codex.includes(found.key) ? value : null; }, 'native Review Codex grant');
        assert.ok(reviewed.lastApplication.targets.some((item) => item.kind === 'codex' && path.resolve(item.path) === path.resolve(rules)),
          'native Review transaction did not target the selected Codex rule file');
        assert.notEqual(fs.readFileSync(rules, 'utf8'), rulesBefore);
        assert.equal(findReviewed(reviewed).counts.success, 3, 'Review prerequisite scan double-counted the three executions');
        // Keep real runtime history watchers from changing learner bytes while
        // the read-only diagnostic is open. Undo and diagnostics remain usable.
        await config.update('autoLearn.enabled', false, vscode.ConfigurationTarget.Global);
        progress('review-granted', { candidateKey: found.key, prefix: found.prefix });
        const allowed = await run(declineContext, 'reviewed-fresh-process', 'allowed');
        assertAllowed(allowed);
        assert.equal(allowed.rollout.status, 'success');
        assert.deepEqual(logLines(logName), [witness, witness, witness, witness]);
        await diagnostic('reviewed-allowed', `${commandName} allowed`, [commandName, 'allowed'], 'allow', allowed);
        const neighbor = await run(neighborContext, 'different-executable-neighbor', 'allowed');
        assertDeclined(neighbor);
        assert.notEqual(neighbor.rollout.status, 'success');
        assert.deepEqual(logLines(neighborLogName), [], 'neighbor executable ran without its own grant');
        await diagnostic('neighbor-declined', `${neighborName} allowed`, [neighborName, 'allowed'], 'none', neighbor);
        if (dashboardUi) await dashboardAction('actual-review-undo', 'undo', buttonStates(true), buttonStates(false));
        else await invoke('autoLearnUndo');
        await waitFor(() => fs.readFileSync(rules, 'utf8') === rulesBefore, 'native Review exact rule undo');
        const undone = state();
        assert.equal(fs.readFileSync(settingsFile, 'utf8'), settingsBefore, 'Undo failed to restore the prior Claude policy bytes');
        assert.deepEqual(undone.reviewed, before.reviewed);
        assert.deepEqual(undone.applied, before.applied);
        assert.equal(undone.lastApplication, null);
        const afterUndo = await run(declineContext, 'undone-fresh-process', 'allowed');
        assertDeclined(afterUndo);
        assert.notEqual(afterUndo.rollout.status, 'success');
        assert.deepEqual(logLines(logName), [witness, witness, witness, witness], 'command still ran after Undo');
        await diagnostic('undone-declined', `${commandName} allowed`, [commandName, 'allowed'], 'none', afterUndo);
        assertInactiveCodexPaths();
        reviewRuntime.status = 'passed';
        progress('review-runtime-complete', { candidateKey: found.key, cases: reviewRuntime.cases.length,
          diagnostics: reviewRuntime.diagnostics.length, dashboardExpected: !!dashboardUi, codexPruneExpected: !!codexPrune, ...followups });
        return `${found.key}: three real accepted executions, deduplicated Scan Now, actual Review/Grant, fresh no-approval execution, different executable declined, Undo restores approval; three actual diagnostic dialogs agree with runtime and leave files unchanged` +
          (dashboardUi ? '; seven dashboard button routes and their enabled states verified' : '');
      } catch (error) {
        reviewRuntime.status = 'failed';
        reviewRuntime.failure = error.stack || error.message;
        progress('review-runtime-failed', { detail: reviewRuntime.failure });
        throw error;
      }
    });
    if (dashboardUi && reviewRuntime?.status !== 'passed') dashboardUi.status = 'not-run';
    if (dashboardUi && reviewRuntime?.status === 'passed') await check('actual dashboard shows Codex-only partial state and adds, cancels, and removes independent managed blocks', async () => {
      const progressFile = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
      const progress = (phase, details = {}) => {
        const next = `${progressFile}.tmp`;
        fs.writeFileSync(next, JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
        fs.renameSync(next, progressFile);
      };
      try {
        assert.equal(reviewRuntime?.status, 'passed', 'dashboard acceptance requires the completed review/runtime group');
        assert.ok(progressFile && path.resolve(path.dirname(progressFile)) === path.resolve(path.dirname(report)),
          'dashboard progress must stay inside the isolated fixture');
        const setting = (name) => vscode.workspace.getConfiguration('permissionWildcarding').get(name);
        assert.equal(setting('guidance.enabled'), false);
        assert.equal(setting('gates.enabled'), false);
        for (const file of instructionFiles) assert.equal(fs.readFileSync(file, 'utf8'), ownInstructions);
        assertInactiveCodexPaths();
        const guidance = require(path.join(extensionDir, 'src', 'agent-guidance.js'));
        const gates = require(path.join(extensionDir, 'src', 'agent-gates.js')).makeGatesBlock(home);
        fs.writeFileSync(codexInstructions, gates.apply(guidance.applyGuidance(ownInstructions, true).text, true).text);
        const snapshot = () => ({ files: Object.fromEntries(instructionFiles.map((file) => [file, fs.readFileSync(file, 'utf8')])),
          guidanceEnabled: setting('guidance.enabled'), gatesEnabled: setting('gates.enabled') });
        const assertFiles = (claudeGuidance, claudeGates, codexGuidance, codexGates) => {
          for (const [file, guidanceOn, gatesOn] of [[instructionFiles[0], claudeGuidance, claudeGates],
            [codexInstructions, codexGuidance, codexGates]]) {
            const content = fs.readFileSync(file, 'utf8');
            assert.ok(content.startsWith(ownInstructions), `dashboard changed user-owned text: ${file}`);
            assert.equal(guidance.hasGuidance(content), guidanceOn, `dashboard guidance state differs: ${file}`);
            assert.equal(gates.has(content), gatesOn, `dashboard gates state differs: ${file}`);
            if (guidanceOn) assert.ok(guidance.isCurrent(content), `dashboard installed stale guidance: ${file}`);
            if (gatesOn) assert.ok(gates.isCurrent(content), `dashboard installed stale gates: ${file}`);
            const userOnly = guidance.applyGuidance(gates.apply(content, false).text, false).text;
            assert.equal(userOnly, ownInstructions, `dashboard changed text outside managed blocks: ${file}`);
          }
          assertInactiveCodexPaths();
        };
        assertFiles(false, false, true, true);
        const exchange = async (phase, caseId, details = {}) => {
          const ackPath = path.join(path.dirname(progressFile), `dashboard-${caseId}.json`);
          assert.equal(fs.existsSync(ackPath), false, `${caseId}: stale dashboard acknowledgement exists`);
          progress(phase, { caseId, ...details, ackPath });
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            if (fs.existsSync(ackPath)) {
              const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
              assert.equal(ack.caseId, caseId);
              assert.equal(ack.status, 'passed', `${caseId}: dashboard UI failed: ${ack.error || ack.detail || 'see renderer report'}`);
              assert.ok(ack.before && ack.after, `${caseId}: dashboard observation evidence is missing`);
              return ack;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(`${caseId}: dashboard UI acknowledgement did not arrive within 60 seconds`);
        };
        // Focusing a freshly shown view uses the real provider's render and
        // visibility refresh; no injected webview messages or private services.
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
        const partialBefore = snapshot();
        const partial = await exchange('dashboard-open', 'partial-codex-only', {
          expected: { guidance: 'partial', gates: 'partial' } });
        assert.equal(partial.clicked, null, 'observing partial badges must not click a managed action');
        assert.deepEqual(snapshot(), partialBefore, 'observing the dashboard changed instruction files or settings');
        dashboardUi.steps.push({ caseId: 'partial-codex-only', ui: partial });
        const expectedDisplayedPaths = instructionFiles.map((file) => file.replace(home, '~'));
        const action = async (caseId, control, actionName, expectedBefore, expectedAfter, expectedFiles, expectedFlags) => {
          const beforeAction = snapshot();
          const ack = await exchange('dashboard-action', caseId, { control, action: actionName,
            expectedBefore, expectedAfter, expectedDisplayedPaths });
          assert.equal(ack.clicked, control === 'guidance' ? 'guidanceBtn' : 'gatesBtn',
            `${caseId}: renderer did not click the expected dashboard control`);
          assert.equal(ack.modalDecision, actionName === 'cancel-remove' ? 'Cancel' : actionName === 'remove' ? 'Remove' : null);
          if (actionName !== 'add') {
            assert.ok(typeof ack.dialogText === 'string');
            for (const target of expectedDisplayedPaths) assert.ok(ack.dialogText.includes(target),
              `${caseId}: removal confirmation omitted target ${target}`);
          }
          await waitFor(() => {
            assertFiles(...expectedFiles);
            assert.equal(setting('guidance.enabled'), expectedFlags[0]);
            assert.equal(setting('gates.enabled'), expectedFlags[1]);
            return true;
          }, `${caseId} file and setting outcomes`);
          if (actionName === 'cancel-remove') assert.deepEqual(snapshot(), beforeAction,
            `${caseId}: Cancel changed managed blocks or persisted intent`);
          dashboardUi.steps.push({ caseId, control, action: actionName, ui: ack,
            guidanceEnabled: setting('guidance.enabled'), gatesEnabled: setting('gates.enabled') });
        };
        await action('guidance-add', 'guidance', 'add',
          { guidance: 'partial', gates: 'partial' }, { guidance: 'on', gates: 'partial' }, [true, false, true, true], [true, false]);
        await action('gates-add', 'gates', 'add',
          { guidance: 'on', gates: 'partial' }, { guidance: 'on', gates: 'on' }, [true, true, true, true], [true, true]);
        await action('guidance-cancel', 'guidance', 'cancel-remove',
          { guidance: 'on', gates: 'on' }, { guidance: 'on', gates: 'on' }, [true, true, true, true], [true, true]);
        await action('guidance-remove', 'guidance', 'remove',
          { guidance: 'on', gates: 'on' }, { guidance: 'off', gates: 'on' }, [false, true, false, true], [false, true]);
        await action('gates-cancel', 'gates', 'cancel-remove',
          { guidance: 'off', gates: 'on' }, { guidance: 'off', gates: 'on' }, [false, true, false, true], [false, true]);
        await action('gates-remove', 'gates', 'remove',
          { guidance: 'off', gates: 'on' }, { guidance: 'off', gates: 'off' }, [false, false, false, false], [false, false]);
        // The partial fixture already held Codex blocks. Repeat Add from a
        // completely empty managed state to prove each button writes Codex too.
        for (const file of instructionFiles) assert.equal(fs.readFileSync(file, 'utf8'), ownInstructions);
        await action('guidance-add-from-off', 'guidance', 'add',
          { guidance: 'off', gates: 'off' }, { guidance: 'on', gates: 'off' }, [true, false, true, false], [true, false]);
        await action('gates-add-from-off', 'gates', 'add',
          { guidance: 'on', gates: 'off' }, { guidance: 'on', gates: 'on' }, [true, true, true, true], [true, true]);
        await action('guidance-remove-after-off-add', 'guidance', 'remove',
          { guidance: 'on', gates: 'on' }, { guidance: 'off', gates: 'on' }, [false, true, false, true], [false, true]);
        await action('gates-remove-after-off-add', 'gates', 'remove',
          { guidance: 'off', gates: 'on' }, { guidance: 'off', gates: 'off' }, [false, false, false, false], [false, false]);
        for (const file of instructionFiles) assert.equal(fs.readFileSync(file, 'utf8'), ownInstructions);
        assertInactiveCodexPaths();
        dashboardUi.status = 'passed';
        progress('ui-complete', { dashboardSteps: dashboardUi.steps.length, codexPruneExpected: !!codexPrune, ...followups });
        return 'Both Codex-only partial badges observed; actual Add from partial and both-off states, Cancel and Remove preserve user text, independent blocks, inactive base and persisted settings';
      } catch (error) {
        dashboardUi.status = 'failed';
        dashboardUi.failure = error.stack || error.message;
        progress('review-runtime-failed', { detail: dashboardUi.failure, group: 'dashboard' });
        throw error;
      }
    });
    if (codexPrune && (reviewRuntime?.status !== 'passed' || (dashboardUi && dashboardUi.status !== 'passed'))) codexPrune.status = 'not-run';
    if (codexPrune && !codexPrune.status) await check('actual Codex inventory cancels and removes a selected allow rule while preserving read-only decisions and durable exclusions', async () => {
      const progressFile = process.env.ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS;
      const progress = (phase, details = {}) => {
        const next = `${progressFile}.tmp`;
        fs.writeFileSync(next, JSON.stringify({ phase, ...details, updatedAt: new Date().toISOString() }, null, 2) + '\n');
        fs.renameSync(next, progressFile);
      };
      try {
        assert.ok(progressFile && path.resolve(path.dirname(progressFile)) === path.resolve(path.dirname(report)),
          'Codex inventory progress must stay inside the isolated profile');
        assert.equal(reviewRuntime?.status, 'passed', 'inventory UI needs the owned normal extension host');
        const config = vscode.workspace.getConfiguration('permissionWildcarding');
        await config.update('autoLearn.enabled', false, vscode.ConfigurationTarget.Global);
        assert.equal(config.get('autoLearn.enabled'), false, 'background learning must remain disabled for removal assertions');
        const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const suffix = createHash('sha256').update(home).digest('hex').slice(0, 10);
        const commandName = `acolyte-prune-${suffix}.cmd`;
        const promptName = `acolyte-prune-prompt-${suffix}.cmd`;
        const forbiddenName = `acolyte-prune-forbidden-${suffix}.cmd`;
        const userText = '# User-owned inventory fixture; keep this line exactly.\n';
        const allowDeclaration = `prefix_rule(pattern = ["${commandName}"], decision = "allow")`;
        const promptDeclaration = `prefix_rule(pattern = ["${promptName}"], decision = "prompt")`;
        const forbiddenDeclaration = `prefix_rule(pattern = ["${forbiddenName}"], decision = "forbidden")`;
        const inventoryFile = path.join(codexHome, 'rules', `acolyte-inventory-${suffix}.rules`);
        const unsupportedFile = path.join(codexHome, 'rules', `acolyte-computed-${suffix}.rules`);
        fs.writeFileSync(inventoryFile, userText + [allowDeclaration, promptDeclaration, forbiddenDeclaration, ''].join('\n'));
        const unsupportedText = `fixture_command = "acolyte-computed-${suffix}.cmd"\nprefix_rule(pattern = [fixture_command], decision = "allow")\n`;
        fs.writeFileSync(unsupportedFile, unsupportedText);
        const { createAutoLearnManager } = require(path.join(extensionDir, 'src', 'auto-learn-manager.js'));
        const managerOptions = { home, codexHome, workspaceRoot: workspace, codexRulesPath: rules,
          mode: 'recommend', threshold: 3, historyScanner: () => ({
            observations: [1, 2, 3].map((index) => ({ id: `inventory-${suffix}-${index}`, source: 'codex',
              tool: 'PowerShell', command: `${commandName} allowed`, status: 'success', cwd: workspace })),
            cursors: {}, files: [{ source: 'codex', mode: 'full' }],
          }) };
        const manager = createAutoLearnManager(managerOptions);
        manager.scan();
        const selectedCandidate = manager.listCandidates().find((item) => item.prefix.length === 1 && item.prefix[0] === commandName);
        assert.ok(selectedCandidate && selectedCandidate.counts.success === 3, 'labelled synthetic eligibility fixture was not recorded');
        const initialInventory = manager.codexInventory();
        const selected = initialInventory.rules.find((item) => item.path === inventoryFile && item.decision === 'allow' && item.pattern[0] === commandName);
        assert.ok(selected?.removable, 'fixture must offer one removable literal allow rule');
        assert.equal(initialInventory.files.find((file) => file.path === unsupportedFile)?.supported, false,
          'fixture must exercise a genuinely unsupported computed file');
        assert.equal(initialInventory.pendingRemoval, false, 'new fixture must not resume a previous removal');
        const collect = (directory) => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
          .flatMap((entry) => entry.isDirectory() ? collect(path.join(directory, entry.name))
            : entry.isFile() && !entry.name.endsWith('.lock') ? [path.join(directory, entry.name)] : []) : [];
        const snapshot = () => Object.fromEntries([...collect(path.join(home, '.claude', 'wildcarding')), ...collect(path.join(home, '.ai-acolyte')),
          ...collect(path.join(codexHome, 'rules')), path.join(home, '.claude', 'settings.json'), ...instructionFiles,
          ...(override ? [path.join(codexHome, 'AGENTS.md')] : [])].sort().map((file) => [file,
          createHash('sha256').update(fs.readFileSync(file)).digest('hex')]));
        const exchange = async (caseId, action, expectedLabel, file, decision, expectedDetailIncludes) => {
          const ackPath = path.join(path.dirname(progressFile), `codex-prune-${caseId}.json`);
          assert.equal(fs.existsSync(ackPath), false, `${caseId}: stale inventory acknowledgement exists`);
          progress('codex-prune-action', { caseId, action, expectedLabel,
            expectedDisplayedPath: file.replace(home, '~'), expectedDecision: decision,
            expectedDescription: action === 'resume' ? ['Codex', 'removal needs attention']
              : decision ? ['Codex', decision] : ['Codex', 'read-only file'],
            expectedDialogTitle: action === 'resume' ? 'Finish interrupted Codex removal?'
              : action === 'inspect' ? 'Codex rule (read-only)' : 'Remove this Codex allow rule?',
            expectedDetailIncludes, ackPath });
          const deadline = Date.now() + 60000;
          while (Date.now() < deadline) {
            if (fs.existsSync(ackPath)) {
              const ack = JSON.parse(fs.readFileSync(ackPath, 'utf8'));
              assert.equal(ack.caseId, caseId);
              assert.equal(ack.status, 'passed', `${caseId}: inventory UI failed: ${ack.error || ack.detail || 'see renderer report'}`);
              assert.equal(ack.clicked, 'codexRules', `${caseId}: inventory must open through the actual dashboard button`);
              assert.equal(ack.selectedLabel, expectedLabel, `${caseId}: a different rule was selected`);
              assert.equal(ack.modalDecision, action === 'resume' ? 'Finish removal'
                : action === 'cancel' ? 'Cancel' : action === 'remove' ? 'Remove' : 'OK');
              if (action !== 'resume') assert.ok(ack.dialogText.includes(file.replace(home, '~')), `${caseId}: dialog omitted the selected source file`);
              for (const text of expectedDetailIncludes) assert.ok(ack.dialogText.includes(text), `${caseId}: dialog omitted ${text}`);
              return ack;
            }
            await new Promise((resolve) => setTimeout(resolve, 100));
          }
          throw new Error(`${caseId}: inventory acknowledgement did not arrive within 60 seconds`);
        };
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
        const expectedLabel = JSON.stringify(selected.pattern);
        const removalDetail = [expectedLabel, 'Decision: allow', 'Current Auto Learn builds will not re-add overlapping prefixes in any workspace',
          'active sessions may cache rules'];
        const beforeCancel = snapshot();
        const cancelled = await exchange('cancel-allow', 'cancel', expectedLabel, inventoryFile, 'allow', removalDetail);
        assert.deepEqual(snapshot(), beforeCancel, 'WITNESS Cancel must preserve all policy, learner, suppression and backup bytes');
        codexPrune.steps.push({ caseId: 'cancel-allow', readOnlyHashes: beforeCancel, ui: cancelled });
        const removed = await exchange('remove-allow', 'remove', expectedLabel, inventoryFile, 'allow', removalDetail);
        // Inventory now retains backup state under the policy lock. Poll only
        // files here, so the acceptance observer cannot contend with the actual
        // worker command it is waiting for.
        await waitFor(() => {
          const record = JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8'));
          return record.pending === null && record.patterns.some((pattern) => JSON.stringify(pattern) === expectedLabel) &&
            !fs.readFileSync(inventoryFile, 'utf8').includes(allowDeclaration);
        }, 'actual removal and durable exclusion');
        const afterInventory = createAutoLearnManager(managerOptions).codexInventory();
        assert.equal(afterInventory.suppressionCount, initialInventory.suppressionCount + 1);
        const edited = fs.readFileSync(inventoryFile, 'utf8');
        assert.ok(edited.startsWith(userText), 'removal changed user-owned policy text');
        assert.equal(edited.includes(allowDeclaration), false, 'WITNESS selected allow declaration must disappear from the actual file');
        assert.ok(edited.includes(promptDeclaration), 'removal changed the prompt declaration');
        assert.ok(edited.includes(forbiddenDeclaration), 'removal changed the forbidden declaration');
        assert.equal(fs.readFileSync(unsupportedFile, 'utf8'), unsupportedText, 'removal changed the unsupported file');
        assertInactiveCodexPaths();
        codexPrune.steps.push({ caseId: 'remove-allow', suppressionCount: afterInventory.suppressionCount,
          policySha256: createHash('sha256').update(edited).digest('hex'), ui: removed });
        const fresh = createAutoLearnManager(managerOptions);
        const excluded = fresh.listCandidates().find((item) => item.key === selectedCandidate.key);
        assert.equal(excluded.codexSuppressed, true, 'fresh manager must remember the removed prefix');
        assert.equal(excluded.eligibleTargets.includes('codex'), false, 'removed prefix remains eligible for Codex');
        const application = fresh.applyCodex({ keys: [excluded.key], includeReviewed: true,
          expectedFingerprints: { [excluded.key]: excluded.fingerprint } });
        assert.equal(application.appliedCount, 0, 'WITNESS fresh Apply must not recreate the removed grant');
        assert.ok(application.withheldByPolicy.some((item) => item.source === 'codex-removal' && item.key === excluded.key),
          'withheld grant must identify the earlier removal');
        assert.equal(createAutoLearnManager(managerOptions).codexInventory().rules.some((rule) =>
          rule.decision === 'allow' && JSON.stringify(rule.pattern) === expectedLabel), false, 'fresh Apply resurrected a removed prefix');
        codexPrune.withheldApplication = application;
        for (const [caseId, command, decision] of [['inspect-prompt', promptName, 'prompt'], ['inspect-forbidden', forbiddenName, 'forbidden']]) {
          const before = snapshot();
          const ack = await exchange(caseId, 'inspect', JSON.stringify([command]), inventoryFile, decision,
            [`Decision: ${decision}`, 'Only allow rules can be removed here.']);
          assert.deepEqual(snapshot(), before, `${caseId}: read-only inspection changed policy or state`);
          codexPrune.steps.push({ caseId, readOnlyHashes: before, ui: ack });
        }
        const beforeUnsupported = snapshot();
        const unsupported = await exchange('inspect-unsupported', 'inspect', unsupportedFile.replace(home, '~'), unsupportedFile, null,
          [afterInventory.files.find((file) => file.path === unsupportedFile).reason]);
        assert.deepEqual(snapshot(), beforeUnsupported, 'unsupported-file inspection changed policy or state');
        codexPrune.steps.push({ caseId: 'inspect-unsupported', readOnlyHashes: beforeUnsupported, ui: unsupported });
        const resumeName = `acolyte-prune-resume-${suffix}.cmd`;
        const resumeDeclaration = `prefix_rule(pattern = ["${resumeName}"], decision = "allow")`;
        fs.appendFileSync(inventoryFile, resumeDeclaration + '\n');
        const resumeRule = createAutoLearnManager(managerOptions).codexInventory().rules.find((rule) =>
          rule.path === inventoryFile && rule.pattern[0] === resumeName);
        assert.ok(resumeRule?.removable, 'interruption fixture must begin with a removable rule');
        let interruptedWrites = 0;
        const failing = createAutoLearnManager({ ...managerOptions, testHooks: { afterPolicyWrite(event) {
          if (event.kind !== 'codex-removal') return;
          assert.equal(event.path, inventoryFile, 'fixture must interrupt only its isolated rule file');
          interruptedWrites++;
          throw new Error('ACOLYTE_NATIVE_REMOVAL_INTERRUPTION');
        } } });
        assert.throws(() => failing.removeCodexRules({ rules: [{ id: resumeRule.id, path: resumeRule.path,
          fileHash: resumeRule.fileHash }] }), /ACOLYTE_NATIVE_REMOVAL_INTERRUPTION/);
        assert.equal(interruptedWrites, 1, 'fixture must execute the real policy write before interruption');
        const removalRecordPath = failing.paths.codexRemovals;
        const pendingRecord = JSON.parse(fs.readFileSync(removalRecordPath, 'utf8'));
        assert.equal(pendingRecord.pending?.removedCount, 1, 'interruption must retain durable removal intent');
        assert.equal(createAutoLearnManager(managerOptions).codexInventory().pendingRemoval, true);
        assert.equal(fs.readFileSync(inventoryFile, 'utf8').includes(resumeDeclaration), false,
          'interruption fixture must occur after the selected declaration was removed');
        const beforeResume = snapshot();
        const resumed = await exchange('finish-interrupted', 'resume', 'Finish interrupted Codex removal', inventoryFile, null,
          ['This finishes the previously confirmed removal', 'active sessions may cache rules']);
        await waitFor(() => JSON.parse(fs.readFileSync(removalRecordPath, 'utf8')).pending === null,
          'actual interrupted-removal recovery');
        const finalRecord = JSON.parse(fs.readFileSync(removalRecordPath, 'utf8'));
        assert.equal(finalRecord.pending, null, 'WITNESS actual Finish removal must clear durable intent');
        assert.deepEqual(finalRecord.lastRemoval, pendingRecord.pending, 'recovery must finish the originally recorded transaction');
        assert.deepEqual(finalRecord.patterns, pendingRecord.patterns, 'recovery must retain both removed prefixes');
        assert.ok(finalRecord.patterns.some((pattern) => JSON.stringify(pattern) === JSON.stringify([resumeName])));
        assert.equal(fs.readFileSync(inventoryFile, 'utf8').includes(resumeDeclaration), false);
        const afterResume = snapshot();
        assert.notEqual(afterResume[removalRecordPath], beforeResume[removalRecordPath], 'recovery must persist completion');
        delete beforeResume[removalRecordPath];
        delete afterResume[removalRecordPath];
        assert.deepEqual(afterResume, beforeResume, 'recovery changed already-written policy or unrelated learner, backup or instruction bytes');
        codexPrune.steps.push({ caseId: 'finish-interrupted', interruption: 'afterPolicyWrite', interruptedWrites,
          removalRecordPath, pendingBefore: pendingRecord.pending, pendingAfter: finalRecord.pending,
          suppressionCount: finalRecord.patterns.length, unchangedHashes: afterResume, ui: resumed });
        assert.equal(codexPrune.steps.length, 6);
        codexPrune.status = 'passed';
        progress('codex-prune-complete', { cases: codexPrune.steps.length, ...followups });
        return 'Six actual dashboard/picker/dialog flows: Cancel preserves every byte; Remove deletes only the selected allow declaration and persists exclusion; fresh Apply is withheld; prompt, forbidden and computed files remain read-only; Finish removal completes interrupted intent without changing already-written policy';
      } catch (error) {
        codexPrune.status = 'failed';
        codexPrune.failure = error.stack || error.message;
        progress('review-runtime-failed', { detail: codexPrune.failure, group: 'codex-prune' });
        throw error;
      }
    });
    if (codexRestore && results.some((item) => item.verdict === 'FAIL')) codexRestore.status = 'not-run';
    if (codexRestore && !codexRestore.status) await check('actual Codex restore cancels, restores a missing rule, preserves intentional exclusions and resumes an interrupted restore', async () => {
      try {
        const config = vscode.workspace.getConfiguration('permissionWildcarding');
        await config.update('autoLearn.enabled', false, vscode.ConfigurationTarget.Global);
        assert.equal(config.get('autoLearn.enabled'), false);
        const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const suffix = createHash('sha256').update(home).digest('hex').slice(0, 10);
        const commandName = `acolyte-restore-${suffix}.cmd`;
        const excludedName = `acolyte-restore-excluded-${suffix}.cmd`;
        const resumeName = `acolyte-restore-resume-${suffix}.cmd`;
        const file = path.join(codexHome, 'rules', `acolyte-restore-${suffix}.rules`);
        const userText = '# Restore fixture user text remains byte-identical.\n';
        const declaration = (name) => `prefix_rule(pattern = ["${name}"], decision = "allow")`;
        fs.writeFileSync(file, userText + [commandName, excludedName, resumeName].map(declaration).join('\n') + '\n');
        const { createAutoLearnManager } = require(path.join(extensionDir, 'src', 'auto-learn-manager.js'));
        const managerOptions = { home, codexHome, workspaceRoot: workspace, codexRulesPath: rules, mode: 'recommend' };
        const manager = createAutoLearnManager(managerOptions);
        const listed = manager.codexInventory();
        assert.ok(fs.existsSync(manager.paths.codexBackup), 'inventory must persist saved rules before the simulated loss');
        const excluded = listed.rules.find((item) => item.path === file && item.pattern[0] === excludedName);
        assert.ok(excluded?.removable);
        manager.removeCodexRules({ rules: [{ id: excluded.id, path: excluded.path, fileHash: excluded.fileHash }] });
        fs.writeFileSync(file, userText);
        const inventory = manager.codexRestoreInventory();
        const selectedFile = inventory.files.find((item) => path.resolve(item.path).toLowerCase() === path.resolve(file).toLowerCase());
        assert.ok(selectedFile?.restore.some((item) => item.pattern[0] === commandName));
        assert.ok(selectedFile.suppressed.some((item) => item.pattern[0] === excludedName));
        const collect = (directory) => fs.existsSync(directory) ? fs.readdirSync(directory, { withFileTypes: true })
          .flatMap((entry) => entry.isDirectory() ? collect(path.join(directory, entry.name))
            : entry.isFile() && !entry.name.endsWith('.lock') ? [path.join(directory, entry.name)] : []) : [];
        const snapshot = () => Object.fromEntries([...collect(path.join(home, '.claude', 'wildcarding')),
          ...collect(path.join(home, '.ai-acolyte')), ...collect(path.join(codexHome, 'rules')),
          ...instructionFiles, ...(override ? [path.join(codexHome, 'AGENTS.md')] : [])].sort().map((target) => [target,
          createHash('sha256').update(fs.readFileSync(target)).digest('hex')]));
        const exchange = async (caseId, expectedLabel, expectedDescription, expectedDialogTitle, expectedDetailIncludes, decision) => {
          const ack = await actionAck(caseId, 'codex-restore', { expectedLabel, expectedDescription,
            expectedPath: selectedFile.path, expectedDialogTitle, expectedDetailIncludes });
          assert.equal(ack.clicked, 'codexRestore');
          assert.equal(ack.selectedLabel, expectedLabel);
          assert.equal(ack.modalDecision, decision);
          for (const text of expectedDetailIncludes) assert.ok(ack.dialogText.includes(text), `${caseId}: actual modal omitted ${text}`);
          return ack;
        };
        await vscode.commands.executeCommand('workbench.action.closeSidebar');
        await vscode.commands.executeCommand('permissionWildcarding.dashboard.focus');
        const label = JSON.stringify([commandName]);
        const details = [label, 'Decision: allow', selectedFile.path, 'preserving current rules', 'Restart Codex'];
        const beforeCancel = snapshot();
        const cancelled = await exchange('cancel-missing', label, ['Codex', 'allow', 'missing rule'], 'Restore this Codex rule?', details, 'Cancel');
        assert.deepEqual(snapshot(), beforeCancel, 'WITNESS restore Cancel must preserve policy, evidence, exclusion and saved-policy bytes');
        codexRestore.steps.push({ caseId: 'cancel-missing', unchangedHashes: beforeCancel, ui: cancelled });
        const restored = await exchange('restore-missing', label, ['Codex', 'allow', 'missing rule'], 'Restore this Codex rule?', details, 'Restore');
        await waitFor(() => fs.readFileSync(file, 'utf8').includes(declaration(commandName)), 'actual restored declaration on disk');
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(text.startsWith(userText));
        assert.equal(text.includes(declaration(excludedName)), false, 'WITNESS restore must not revive intentional removal');
        assert.equal(text.includes(declaration(resumeName)), false, 'restore must add only the selected missing rule');
        assert.equal(JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8')).pending, null);
        codexRestore.steps.push({ caseId: 'restore-missing', policySha256: createHash('sha256').update(text).digest('hex'), ui: restored });
        const beforeInspect = snapshot();
        const inspected = await exchange('inspect-excluded', JSON.stringify([excludedName]), ['Excluded by an intentional removal'],
          'Excluded by an intentional removal', [selectedFile.path], 'OK');
        assert.deepEqual(snapshot(), beforeInspect, 'excluded restore row must remain read-only');
        codexRestore.steps.push({ caseId: 'inspect-excluded', unchangedHashes: beforeInspect, ui: inspected });
        const pendingFile = manager.codexRestoreInventory().files.find((item) => item.path === selectedFile.path);
        const pendingRule = pendingFile.restore.find((item) => item.pattern[0] === resumeName);
        assert.ok(pendingRule, 'recovery fixture requires a second missing rule');
        let interruptedWrites = 0;
        const failing = createAutoLearnManager({ ...managerOptions, testHooks: { afterPolicyWrite(event) {
          if (event.kind !== 'codex-restore') return;
          assert.equal(path.resolve(event.path).toLowerCase(), path.resolve(file).toLowerCase());
          interruptedWrites++;
          throw new Error('ACOLYTE_NATIVE_RESTORE_INTERRUPTION');
        } } });
        assert.throws(() => failing.restoreCodexRules({ path: pendingFile.path, expectedHash: pendingFile.beforeHash,
          expectedExists: pendingFile.exists, ids: [pendingRule.id] }), /ACOLYTE_NATIVE_RESTORE_INTERRUPTION/);
        assert.equal(interruptedWrites, 1);
        const pending = JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8'));
        assert.equal(pending.pending?.kind, 'restore');
        assert.ok(fs.readFileSync(file, 'utf8').includes(declaration(resumeName)), 'interruption must occur after policy restoration');
        const beforeResume = snapshot();
        const resumed = await exchange('finish-interrupted', null, [], 'Finish interrupted Codex restore?',
          ['Finish the restore you already confirmed', 'Changed files are preserved', 'Restart Codex'], 'Finish restore');
        await waitFor(() => JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8')).pending === null,
          'actual interrupted-restore recovery');
        const finalRecord = JSON.parse(fs.readFileSync(manager.paths.codexRemovals, 'utf8'));
        assert.deepEqual(finalRecord.lastRestore, pending.pending);
        assert.deepEqual(finalRecord.patterns, pending.patterns, 'restore recovery changed intentional exclusions');
        const afterResume = snapshot();
        assert.notEqual(beforeResume[manager.paths.codexRemovals], afterResume[manager.paths.codexRemovals]);
        delete beforeResume[manager.paths.codexRemovals];
        delete afterResume[manager.paths.codexRemovals];
        assert.deepEqual(afterResume, beforeResume, 'recovery changed already-restored policy or unrelated saved state');
        assertInactiveCodexPaths();
        codexRestore.steps.push({ caseId: 'finish-interrupted', interruptedWrites, pendingBefore: pending.pending,
          pendingAfter: finalRecord.pending, unchangedHashes: afterResume, ui: resumed });
        codexRestore.paths = { policy: file, backup: manager.paths.codexBackup, journal: manager.paths.codexRemovals };
        codexRestore.status = 'passed';
        writeProgress('codex-restore-complete', { cases: codexRestore.steps.length, codexDerivedExpected: !!codexDerived });
        return 'Four actual dashboard flows: Cancel preserves all bytes, selected Restore adds only its missing rule, intentional exclusions remain read-only, and Finish restore clears interrupted intent without rewriting restored policy';
      } catch (error) {
        codexRestore.status = 'failed'; codexRestore.failure = error.stack || error.message;
        writeProgress('review-runtime-failed', { group: 'codex-restore', detail: codexRestore.failure });
        throw error;
      }
    });
    if (codexDerived && results.some((item) => item.verdict === 'FAIL')) codexDerived.status = 'not-run';
    if (codexDerived && !codexDerived.status) await check('actual derived-guidance review accepts and declines Codex-specific advice and fresh processes load only the accepted text', async () => {
      try {
        const config = vscode.workspace.getConfiguration('permissionWildcarding');
        await config.update('autoLearn.enabled', false, vscode.ConfigurationTarget.Global);
        assert.equal(config.get('autoLearn.enabled'), false, 'background scanning must not inflate the staged evidence');
        const workspace = vscode.workspace.workspaceFolders[0].uri.fsPath;
        const { createAutoLearnManager } = require(path.join(extensionDir, 'src', 'auto-learn-manager.js'));
        const { renderMitigation, markersFor } = require(path.join(extensionDir, 'src', 'derived-guidance.js'));
        const bundlePath = path.join(codexHome, 'cloud-config-bundle-cache.json');
        assert.equal(fs.existsSync(bundlePath), false, 'managed-policy fixture must not overwrite an existing cache');
        fs.writeFileSync(bundlePath, JSON.stringify({ signed_payload: { bundle: { requirements_toml: { enterprise_managed: [{
          contents: '[[rules.prefix_rules]]\npattern = [{ token = "git" }]\ndecision = "prompt"\n',
        }] } } } }, null, 2) + '\n');
        const manager = createAutoLearnManager({ home, codexHome, workspaceRoot: workspace, codexRulesPath: rules, mode: 'recommend',
          historyScanner: () => ({ observations: [
            ...Array.from({ length: 50 }, (_, index) => ({ id: `derived-codex-${index}`, source: 'codex', tool: 'Bash', command: 'git log', status: 'success', cwd: workspace })),
            ...Array.from({ length: 70 }, (_, index) => ({ id: `derived-claude-${index}`, source: 'claude', tool: 'Bash', command: 'git log', status: 'success', cwd: workspace })),
          ], cursors: {}, files: [{ source: 'codex', mode: 'full' }] }) });
        manager.scan();
        const review = manager.derivedReview();
        const mitigation = review.pending.find((item) => item.id === 'codex-reuse-repository-queries');
        assert.ok(mitigation, 'current staged managed prompt policy must derive one Codex suggestion');
        assert.equal(mitigation.observedRuns, 50, 'WITNESS only Codex successful observations may justify Codex advice');
        assert.equal(mitigation.agent, 'codex');
        assert.equal(mitigation.prompts, undefined);
        const marker = markersFor(mitigation.id);
        const rendered = renderMitigation(mitigation);
        const instructionsBefore = fs.readFileSync(codexInstructions, 'utf8');
        const claudeBefore = fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8');
        const detail = ['50 observed successful Codex runs', 'not a count of historical approval prompts',
          'unless files, repository state or the requested scope changed'];
        const decide = async (caseId, action, expectedState) => {
          const ackPromise = actionAck(caseId, 'codex-derived', { action, expectedLabel: mitigation.title,
            expectedDescription: ['Codex', '50 observed runs', expectedState], expectedDetailIncludes: detail });
          const command = invoke('derivedGuidance');
          const ack = await ackPromise;
          await command;
          assert.equal(ack.selectedLabel, mitigation.title);
          assert.equal(ack.decision, action === 'accept' ? 'Accept' : 'Decline');
          for (const text of ['Codex', '50 observed runs', expectedState, ...detail]) assert.ok(ack.selectedText.includes(text), `${caseId}: actual picker omitted ${text}`);
          for (const text of [expectedState, ...detail]) assert.ok(ack.dialogText.includes(text), `${caseId}: full-body decision modal omitted ${text}`);
          return ack;
        };
        const accepted = await decide('accept-derived', 'accept', 'not yet decided');
        const installed = fs.readFileSync(codexInstructions, 'utf8');
        assert.ok(installed.includes(marker.begin) && installed.includes(rendered), 'WITNESS actual Accept must write the reviewed Codex body');
        assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), claudeBefore);
        assert.ok(state().derivedGuidance.accepted.includes(mitigation.id));
        assertInactiveCodexPaths();
        codexDerived.steps.push({ caseId: 'accept-derived', agent: mitigation.agent, observedRuns: mitigation.observedRuns,
          instructionSha256: createHash('sha256').update(installed).digest('hex'), ui: accepted });
        const { createRuntimeContext, runtimeCase, assertDeclined } = require('../check-codex-runtime.js');
        const suffix = createHash('sha256').update(home).digest('hex').slice(0, 10);
        const commandName = `acolyte-derived-${suffix}.cmd`;
        const witness = `ACOLYTE_DERIVED_${suffix}`;
        fs.writeFileSync(path.join(workspace, commandName), `@echo off\r\necho ${witness}\r\n`);
        const run = async (name, present) => {
          const context = createRuntimeContext({ extensionDir, home, codexHome, workspace, commandName,
            shellWitness: witness, approvalDecision: 'decline', customLayout: override,
            instructionWitnesses: { user: 'Keep this user-owned line.', gate: 'Fixture standing order',
              ...(override ? { shadowed: 'This base file must stay byte-identical.' } : {}) },
            instructionChecks: { required: present ? [rendered] : ['Keep this user-owned line.'], absent: present ? [] : [rendered, marker.begin] } });
          try {
            const result = await runtimeCase(context, name, 'check', false);
            codexDerived.cases.push(result);
            assertDeclined(result);
          } catch (error) { if (error.runtimeEvidence) codexDerived.cases.push(error.runtimeEvidence); throw error; }
        };
        await run('derived-accepted-loaded', true);
        const declined = await decide('decline-derived', 'decline', 'installed');
        assert.equal(fs.readFileSync(codexInstructions, 'utf8'), instructionsBefore, 'WITNESS actual Decline must restore all prior Codex instruction bytes');
        assert.equal(fs.readFileSync(path.join(home, '.claude', 'CLAUDE.md'), 'utf8'), claudeBefore);
        assert.ok(state().derivedGuidance.declined.includes(mitigation.id));
        assert.equal(state().derivedGuidance.accepted.includes(mitigation.id), false);
        codexDerived.steps.push({ caseId: 'decline-derived', ui: declined });
        await run('derived-declined-absent', false);
        codexDerived.status = 'passed';
        writeProgress('codex-derived-complete', { decisions: 2, freshProcesses: 2 });
        return 'Actual Accept/Decline pickers preserve Claude and inactive Codex text; 50 Codex runs stay distinct from 70 Claude runs; fresh Codex processes load accepted guidance and omit it after decline';
      } catch (error) {
        codexDerived.status = 'failed'; codexDerived.failure = error.stack || error.message;
        writeProgress('review-runtime-failed', { group: 'codex-derived', detail: codexDerived.failure });
        throw error;
      }
    });
  } finally {
    const artifactHashes = Object.fromEntries([
      'extension.js', 'src/history-adapters.js', 'src/auto-learn-manager.js', 'src/codex-claims.js', 'src/agent-guidance.js', 'src/codex-paths.js', 'package.json',
      ...(codexPrune ? ['autoLearnUi.js', 'src/codex-rule-inventory.js', 'src/codex-rule-store.js'] : []),
      ...(codexRestore ? ['src/codex-policy-backup.js', 'src/codex-rule-store.js'] : []),
      ...(codexDerived ? ['autoLearnUi.js', 'src/derived-guidance.js'] : []),
    ].map((file) => [file, createHash('sha256').update(fs.readFileSync(path.join(extensionDir, file))).digest('hex')]));
    fs.writeFileSync(report, JSON.stringify({ vscodeVersion: vscode.version, nodeVersion: process.version,
      extensionDir, artifactHashes, home, codexHome, codexLayout, results,
      ...(reviewRuntime ? { reviewRuntime } : {}), ...(dashboardUi ? { dashboardUi } : {}),
      ...(codexPrune ? { codexPrune } : {}), ...(codexRestore ? { codexRestore } : {}),
      ...(codexDerived ? { codexDerived } : {}) }, null, 2) + '\n');
  }
  assert.equal(results.filter((item) => item.verdict === 'FAIL').length, 0, 'real VS Code acceptance failed; see acceptance.json');
};
