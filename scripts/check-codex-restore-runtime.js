#!/usr/bin/env node
'use strict';

// Development staging only. No model inference, credentials or live policy.
// node scripts/check-codex-restore-runtime.js --extension-dir <staged-extension>
//   [--codex <executable>] [--codex-layout default|custom-override]
// Retains isolated policy, claims, backup, rollouts and evidence.json.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRuntimeContext, runtimeCase, rolloutFor, assertAllowed, assertDeclined } = require('./check-codex-runtime');

const BOUNDARY = 'Named staged extension manager; three synthetic success observations per candidate and explicit fingerprint-based review. Real Codex execpolicy validation, fresh app-server processes and harmless shell execution. Scripted loopback model responder; no inference, credentials, real-history learning or VS Code UI claim.';
const SECRET_ENV = ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
  'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT'];
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', ...SECRET_ENV];
const MODULES = ['auto-learn-manager', 'codex-rule-store', 'codex-policy-backup', 'codex-rule-inventory', 'codex-claims'];
const hash = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const fileHash = (file) => hash(fs.readFileSync(file));
const json = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    assert.ok(['--extension-dir', '--codex', '--codex-layout'].includes(key) && argv[i + 1],
      'usage: check-codex-restore-runtime.js --extension-dir path [--codex executable] [--codex-layout default|custom-override]');
    assert.equal(args[key], undefined, `duplicate option ${key}`);
    args[key] = argv[i + 1];
  }
  assert.ok(args['--extension-dir'], '--extension-dir must explicitly name the staged subject');
  assert.ok(!args['--codex-layout'] || ['default', 'custom-override'].includes(args['--codex-layout']), 'unknown Codex layout');
  return args;
}

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `fixture must not follow linked files: ${file}`);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  }).sort();
}

function subjectFiles(extension) {
  const files = [path.join(extension, 'package.json'), path.join(extension, 'extension.js'),
    ...filesBelow(path.join(extension, 'src')).filter((file) => file.endsWith('.js'))];
  return Object.fromEntries(files.map((file) => [path.relative(extension, file).replace(/\\/g, '/'),
    { sha256: fileHash(file), mtimeMs: fs.statSync(file).mtimeMs }]));
}

async function main() {
  assert.equal(process.platform, 'win32', 'this runtime fixture currently targets Windows');
  const args = parseArgs(process.argv.slice(2));
  const extension = path.resolve(args['--extension-dir']);
  assert.ok(fs.existsSync(path.join(extension, 'extension.js')), `staged extension missing: ${extension}`);
  for (const name of MODULES) assert.ok(fs.existsSync(path.join(extension, 'src', `${name}.js`)), `staged subject missing ${name}`);
  const customLayout = args['--codex-layout'] === 'custom-override';
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-restore-runtime-'));
  const root = path.join(evidenceRoot, 'isolated-state');
  const home = path.join(root, 'home');
  const codexHome = customLayout ? path.join(root, 'custom-codex') : path.join(home, '.codex');
  const workspaces = ['a', 'b'].map((name) => path.join(root, `workspace-${name}`));
  const reportPath = path.join(evidenceRoot, 'evidence.json');
  const started = Date.now();
  const report = { status: 'running', boundary: BOUNDARY, extension,
    subjectVersion: json(path.join(extension, 'package.json')).version,
    codexLayout: customLayout ? 'custom-override' : 'default',
    evidenceRoot, isolatedStateRetained: true, startedAt: new Date(started).toISOString(),
    subjectFiles: subjectFiles(extension),
    harnessHashes: { restore: fileHash(__filename), runtime: fileHash(path.join(__dirname, 'check-codex-runtime.js')) },
    steps: [], execpolicyCases: [], runtimeCases: [] };
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  save();
  try {
    for (const directory of [codexHome, path.join(home, '.claude'), ...workspaces]) fs.mkdirSync(directory, { recursive: true });
    Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome });
    for (const key of SECRET_ENV) delete process.env[key];
    assert.equal(os.homedir(), home, 'isolate home before loading any staged subject module');
    const { createAutoLearnManager } = require(path.join(extension, 'src', 'auto-learn-manager.js'));
    const { commandLaunch } = require(path.join(extension, 'src', 'exec-resolve.js'));
    const { parseCodexRules, removeRuleSpans } = require(path.join(extension, 'src', 'codex-rule-inventory.js'));
    const { codexRuleFileSet, codexRulesArguments } = require(path.join(extension, 'src', 'codex-policy.js'));
    const executable = args['--codex'] || 'codex';
    const launch = commandLaunch(executable, ['--version']);
    assert.ok(launch.resolved, 'Codex executable is not reachable');
    const version = spawnSync(launch.file, launch.args, { ...launch.options, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(version.status, 0, `Codex version probe failed: ${version.error?.message || version.stderr}`);
    report.codexVersion = version.stdout.trim();
    assert.match(report.codexVersion, /^codex-cli \S+$/, 'record exact CLI version');
    report.codexResolvedExecutable = launch.resolved;
    report.codexResolvedExecutableHash = fileHash(launch.resolved);
    console.log(`Subject: AI Acolyte ${report.subjectVersion}; ${report.codexVersion}; ${extension}`);
    console.log(BOUNDARY);
    console.log(`Codex layout: ${report.codexLayout}; evidence: ${reportPath}`);

    const suffix = crypto.randomBytes(5).toString('hex');
    const commands = [`acolyte-restore-${suffix}.cmd`, `acolyte-survivor-${suffix}.cmd`];
    const shellWitness = `acolyte-restore-executed-${suffix}`;
    const userWitness = `acolyte-restore-user-instructions-${suffix}`;
    const shadowedWitness = `acolyte-restore-shadowed-instructions-${suffix}`;
    const instructions = path.join(codexHome, customLayout ? 'AGENTS.override.md' : 'AGENTS.md');
    fs.writeFileSync(instructions, `# User instructions\n${userWitness}\n`);
    if (customLayout) fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), `# Inactive base\n${shadowedWitness}\n`);
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{"fixtureUserSetting":"preserve"}\r\n');
    const rules = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
    const sibling = path.join(codexHome, 'rules', 'user-restrictions.rules');
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    const originalRules = `# User-owned policy bytes ${suffix} café\r\n`;
    fs.writeFileSync(rules, originalRules);
    fs.writeFileSync(sibling, '# User-owned restrictions\r\n' + ['prompt', 'forbidden']
      .map((decision) => `prefix_rule(pattern=${JSON.stringify([commands[0], decision])},decision="${decision}")\r\n`).join(''));
    const preserved = Object.fromEntries([settings, sibling, instructions, ...(customLayout ? [path.join(codexHome, 'AGENTS.md')] : [])]
      .map((file) => [file, fileHash(file)]));
    const logs = workspaces.map((workspace) => path.join(workspace, 'execution-witness.log'));
    const managers = workspaces.map((workspaceRoot, index) => {
      fs.writeFileSync(path.join(workspaceRoot, commands[index]),
        `@echo off\r\necho ${shellWitness}>>"%~dp0execution-witness.log"\r\necho ${shellWitness}\r\n`);
      return createAutoLearnManager({ home, codexHome, workspaceRoot, codexRulesPath: rules,
        claudeSettingsPath: null, managedPolicyPath: path.join(home, '.claude', 'managed-settings.json'),
        codexExecutable: executable, mode: 'recommend', threshold: 3,
        historyScanner: () => ({ observations: [1, 2, 3].map((n) => ({
          id: `restore-${index}-synthetic-${n}`, source: 'codex', tool: 'PowerShell',
          command: `${commands[index]} allowed`, status: 'success', cwd: workspaceRoot,
        })), cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
      });
    });
    assert.notEqual(managers[0].paths.state, managers[1].paths.state, 'workspaces require separate evidence');
    assert.equal(managers[0].paths.codexRules, managers[1].paths.codexRules, 'workspaces share the actual policy target');
    assert.equal(managers[0].paths.codexClaims, managers[1].paths.codexClaims, 'workspaces share claims');
    const contexts = workspaces.map((workspace, index) => createRuntimeContext({
      extensionDir: extension, workspace, home, codexHome, customLayout, commandName: commands[index],
      shellWitness, codexExecutable: executable, approvalDecision: 'decline',
      instructionWitnesses: { user: userWitness, shadowed: shadowedWitness, gate: `absent-gate-${suffix}` },
    }));
    report.fixture = { home, codexHome, rules, sibling, workspaces, commands, logs,
      statePaths: managers.map((manager) => manager.paths.state), backup: managers[0].paths.codexBackup, preserved };
    const preserveUserFiles = () => {
      assert.ok(fs.readFileSync(rules, 'utf8').startsWith(originalRules), 'outside generated block user bytes remain intact');
      for (const [file, expected] of Object.entries(preserved)) assert.equal(fileHash(file), expected, `user file changed: ${file}`);
      if (customLayout) assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'custom layout must not create default Codex home');
    };
    const snapshot = () => Object.fromEntries([...new Set([rules, sibling, managers[0].paths.codexBackup,
      ...filesBelow(path.join(home, '.claude', 'wildcarding')).filter((file) => !file.endsWith('.lock'))])]
      .sort().map((file) => [path.relative(root, file).replace(/\\/g, '/'), fs.existsSync(file) ? fileHash(file) : null]));
    function grant(index) {
      managers[index].scan();
      const candidates = managers[index].listCandidates();
      assert.equal(candidates.length, 1, 'synthetic scan must yield exactly one candidate');
      const item = candidates[0];
      assert.deepEqual(item.prefix, [commands[index]], 'review the exact unique executable prefix');
      assert.equal(item.counts.success, 3, 'three labelled synthetic observations establish eligibility');
      assert.equal(item.baseAutoSafe, false, 'custom executable requires explicit review');
      const result = managers[index].applyCodex({ keys: [item.key], includeReviewed: true,
        expectedFingerprints: { [item.key]: item.fingerprint } });
      assert.equal(result.appliedCount, 1, 'review applies exactly one candidate');
      assert.ok(json(managers[index].paths.state).reviewed.codex.includes(item.key), 'reviewed grant persists');
      const retained = json(managers[index].paths.codexBackup);
      assert.ok(retained.files.some((file) => file.rules.some((rule) => rule.managed && rule.pattern[0] === commands[index])),
        'WITNESS successful grant is immediately retained in the high-water catalog');
      assert.ok(path.relative(codexHome, managers[index].paths.codexBackup).startsWith('..'), 'backup survives loss of Codex home');
      report.steps.push({ name: `grant-and-retain-workspace-${index}`, candidate: item.key, fingerprint: item.fingerprint, result, after: snapshot() });
      preserveUserFiles(); save();
    }
    function restrictions(name) {
      const before = snapshot();
      const set = codexRuleFileSet({ home, codexHome, target: rules });
      assert.deepEqual(set.failures, [], 'actual local rules enumeration must be complete');
      assert.ok(set.files.includes(sibling), 'actual sibling restrictions must be included');
      for (const expected of ['prompt', 'forbidden']) {
        const args = ['execpolicy', 'check', ...codexRulesArguments(set.files), '--', commands[0], expected];
        const invocation = commandLaunch(executable, args);
        const result = spawnSync(invocation.file, invocation.args, { ...invocation.options, windowsHide: true, encoding: 'utf8', timeout: 15000 });
        const item = { name: `${name}-${expected}`, args, status: result.status, stdout: result.stdout, stderr: result.stderr, passed: false };
        report.execpolicyCases.push(item); save();
        assert.equal(result.status, 0, `${name}: actual execpolicy check must run successfully`);
        assert.equal(JSON.parse(result.stdout).decision, expected, `WITNESS sibling ${expected} survives ${name}`);
        item.passed = true;
      }
      assert.deepEqual(snapshot(), before, 'execpolicy probes are read-only');
      preserveUserFiles(); save();
    }
    async function check(index, name, allowed, argument = 'allowed') {
      const beforeLog = fs.existsSync(logs[index]) ? fs.readFileSync(logs[index], 'utf8') : '';
      const beforePolicy = snapshot();
      let result;
      try { result = await runtimeCase(contexts[index], name, argument, false); }
      catch (error) {
        if (error.runtimeEvidence) report.runtimeCases.push({ ...error.runtimeEvidence, expected: allowed ? 'allow' : 'prompt', passed: false });
        throw error;
      }
      result.expected = allowed ? 'allow' : 'prompt'; result.passed = false;
      report.runtimeCases.push(result);
      if (allowed) assertAllowed(result); else assertDeclined(result);
      const afterLog = fs.existsSync(logs[index]) ? fs.readFileSync(logs[index], 'utf8') : '';
      assert.equal(afterLog, allowed ? beforeLog + shellWitness + '\r\n' : beforeLog,
        `${name}: execution witness must reflect exactly the permitted process`);
      assert.deepEqual(snapshot(), beforePolicy, `${name}: runtime must not amend policy, claims, backup or learner state`);
      assert.ok(!report.runtimeCases.slice(0, -1).some((prior) => prior.threadId === result.threadId), `${name}: fresh runtime required`);
      const rollout = rolloutFor(codexHome, result.threadId);
      result.rollout = { path: rollout, sha256: fileHash(rollout) };
      result.executionLog = { path: logs[index], beforeBytes: Buffer.byteLength(beforeLog), afterBytes: Buffer.byteLength(afterLog) };
      preserveUserFiles(); result.passed = true; save();
      console.log(`PASS ${name}: approvals=${result.approvals}, command=${result.commandItems[0].status}`);
    }

    await check(0, 'absent-rule-prompts', false);
    restrictions('before-grant');
    grant(0); await check(0, 'reviewed-grant-allows', true);
    grant(1); await check(1, 'other-workspace-grant-allows', true);
    const originalClaims = json(managers[0].paths.codexClaims);
    const survivingOwner = Object.entries(originalClaims.claimants).find(([, text]) => text.includes(commands[1]));
    const lostOwner = Object.entries(originalClaims.claimants).find(([, text]) => text.includes(commands[0]));
    assert.ok(survivingOwner && lostOwner && survivingOwner[0] !== lostOwner[0], 'fixture needs independent real claims');
    const beforeLoss = fs.readFileSync(rules, 'utf8');
    const declarations = parseCodexRules(beforeLoss).rules.filter((rule) => rule.pattern[0] === commands[0]);
    assert.equal(declarations.length, 1, 'external loss fixture must remove only the first grant');
    fs.writeFileSync(rules, removeRuleSpans(beforeLoss, declarations));
    report.steps.push({ name: 'simulate-external-loss-of-one-generated-declaration', beforeHash: hash(beforeLoss), after: snapshot() });
    save();
    await check(0, 'externally-lost-rule-prompts', false);
    await check(1, 'live-shared-grant-survives-external-loss', true);
    const view = managers[0].codexRestoreInventory();
    const missing = view.files.find((file) => file.restore?.some((rule) => rule.pattern[0] === commands[0]));
    assert.ok(missing?.supported, 'missing retained declaration must be offered for reviewed restoration');
    const records = missing.restore.filter((rule) => rule.pattern[0] === commands[0]);
    assert.equal(records.length, 1, 'restore exactly one original declaration');
    const selection = { path: missing.path, expectedHash: missing.beforeHash, expectedExists: missing.exists,
      ids: records.map((rule) => rule.id) };
    const restored = managers[0].restoreCodexRules(selection);
    assert.equal(restored.restoredCount, 1, 'selected restoration must write one rule');
    const afterClaims = json(managers[0].paths.codexClaims);
    assert.equal(afterClaims.claimants[survivingOwner[0]], survivingOwner[1], 'WITNESS unrelated workspace claim survives restoration');
    assert.equal(afterClaims.claimants[lostOwner[0]], undefined, 'WITNESS historical claimant must not be revived');
    assert.ok(afterClaims.baseline.includes(commands[0]), 'reviewed restored declaration becomes baseline');
    report.steps.push({ name: 'restore-retained-declaration', selection, result: restored, after: snapshot() });
    save();
    await check(0, 'restored-rule-allows-fresh-process', true);
    restrictions('after-restore');
    await check(0, 'sibling-prompt-still-prompts-after-restore', false, 'prompt');
    const removable = managers[0].codexInventory().rules.filter((rule) =>
      JSON.stringify(rule.pattern) === JSON.stringify([commands[0]]));
    assert.equal(removable.length, 1);
    const removed = managers[0].removeCodexRules({ rules: [{ id: removable[0].id, path: removable[0].path, fileHash: removable[0].fileHash }] });
    assert.equal(removed.removedCount, 1, 'intentional removal must remove one rule');
    report.steps.push({ name: 'intentional-removal', result: removed, after: snapshot() }); save();
    await check(0, 'intentionally-removed-rule-prompts', false);
    await check(1, 'unrelated-claim-survives-restored-rule-removal', true);
    const suppressedView = managers[0].codexRestoreInventory();
    const suppressed = suppressedView.files.find((file) => file.path === missing.path);
    assert.ok(suppressed.suppressed.some((rule) => rule.id === records[0].id), 'WITNESS explicit removal suppresses retained allow');
    assert.ok(!suppressed.restore.some((rule) => rule.id === records[0].id), 'suppressed declaration is not offered again');
    const refusedSelection = { path: suppressed.path, expectedExists: suppressed.exists, expectedHash: suppressed.beforeHash, ids: [records[0].id] };
    const beforeRefusal = snapshot();
    assert.throws(() => managers[0].restoreCodexRules(refusedSelection), /suppressed|restore|selected|available|removal/i,
      'WITNESS explicitly selecting a suppressed saved allow refuses');
    assert.deepEqual(snapshot(), beforeRefusal, 'suppressed restore refusal must leave all durable bytes unchanged');
    report.steps.push({ name: 'suppressed-restore-refused', selection: refusedSelection, unchanged: true }); save();
    restrictions('after-intentional-removal');
    await check(0, 'suppressed-restore-cannot-regrant', false);
    assert.equal(report.runtimeCases.length, 10, 'all ten fresh runtime cases must execute');
    assert.equal(report.runtimeCases.filter((item) => item.passed).length, 10);
    assert.equal(report.execpolicyCases.length, 6, 'both sibling restriction decisions checked in all three states');
    assert.ok(report.execpolicyCases.every((item) => item.passed));
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  } finally {
    try {
      assert.deepEqual(subjectFiles(extension), report.subjectFiles, 'staged subject changed during check');
      assert.equal(fileHash(__filename), report.harnessHashes.restore, 'restore harness changed during check');
      assert.equal(fileHash(path.join(__dirname, 'check-codex-runtime.js')), report.harnessHashes.runtime, 'runtime helper changed during check');
      report.subjectUnchanged = true;
      report.loadedSubjectModules = Object.keys(require.cache).filter((file) => file.startsWith(extension + path.sep))
        .map((file) => ({ file: path.relative(extension, file).replace(/\\/g, '/'), sha256: fileHash(file), mtimeMs: fs.statSync(file).mtimeMs }));
      for (const name of MODULES) assert.ok(report.loadedSubjectModules.some((item) => item.file === `src/${name}.js`), `staged ${name} module must have executed`);
    } catch (error) {
      report.integrityFailure = String(error.message || error); report.status = 'failed'; process.exitCode = 1;
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    report.finishedAt = new Date().toISOString(); report.elapsedMs = Date.now() - started;
    report.runtimePasses = report.runtimeCases.filter((item) => item.passed).length;
    save();
    console.log(`${report.status.toUpperCase()}: ${report.runtimePasses}/10 fresh runtime cases; evidence ${reportPath}`);
    if (report.failure) console.error(report.failure);
    if (report.integrityFailure) console.error(report.integrityFailure);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
