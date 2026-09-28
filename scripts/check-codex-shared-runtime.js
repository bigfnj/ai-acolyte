#!/usr/bin/env node
'use strict';

// Packaged manager grants, real execpolicy validation and fresh Codex processes.
// Eligibility observations are synthetic, explicitly reviewed fixture evidence.
// The runtime uses the scripted loopback responder from check-codex-runtime.js;
// it performs no model inference and sends no provider credentials.
//
// node scripts/check-codex-shared-runtime.js [--extension-dir <directory>]
//   [--codex <executable>] [--codex-layout default|custom-override]
// Retains its isolated profiles and evidence.json under the printed temp path.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRuntimeContext, runtimeCase, assertAllowed, assertDeclined } = require('./check-codex-runtime');

const BOUNDARY = 'Packaged manager with synthetic successful observations and explicit fingerprint-based review; real Codex execpolicy validation and fresh app-server processes. Scripted loopback responder, no inference, credentials, VS Code UI, or real-history learning claim.';
const CONFLICT = /other workspace|shared|claim|policy changed after Auto Learn wrote it/i;
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME'];

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    const key = argv[i];
    assert.ok(['--extension-dir', '--codex', '--codex-layout'].includes(key) && argv[i + 1],
      'usage: check-codex-shared-runtime.js [--extension-dir path] [--codex executable] [--codex-layout default|custom-override]');
    assert.equal(result[key], undefined, `duplicate option ${key}`);
    result[key] = argv[i + 1];
  }
  assert.ok(!result['--codex-layout'] || ['default', 'custom-override'].includes(result['--codex-layout']), 'unknown Codex layout');
  return result;
}

function hash(data) { return crypto.createHash('sha256').update(data).digest('hex'); }
function fileHash(file) { return hash(fs.readFileSync(file)); }
function json(file) { return JSON.parse(fs.readFileSync(file, 'utf8')); }

function filesBelow(directory) {
  if (!fs.existsSync(directory)) return [];
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    assert.ok(!entry.isSymbolicLink(), `fixture must not follow a symbolic link: ${file}`);
    return entry.isDirectory() ? filesBelow(file) : entry.isFile() ? [file] : [];
  }).sort();
}

function subjectHashes(extension) {
  const modules = filesBelow(path.join(extension, 'src')).filter((file) => file.endsWith('.js'));
  return Object.fromEntries([path.join(extension, 'package.json'), path.join(extension, 'extension.js'), ...modules]
    .map((file) => [path.relative(extension, file).replace(/\\/g, '/'), fileHash(file)]));
}

// All workspace states and any shared ownership ledgers are included. The only
// excluded paths are transient locks and transaction backup copies. The policy
// itself is included separately, even if absent. This does not inspect Codex's
// changing session database, which a fresh runtime process legitimately writes.
function sharedSnapshot(fixture) {
  const root = path.join(fixture.home, '.claude', 'wildcarding');
  const records = filesBelow(root).filter((file) => {
    const parts = path.relative(root, file).split(path.sep);
    return !parts.includes('backups') && !parts.some((part) => part.endsWith('.lock'));
  });
  const paths = [fixture.rules, ...records];
  return Object.fromEntries(paths.map((file) => {
    const key = path.relative(fixture.root, file).replace(/\\/g, '/');
    const bytes = fs.existsSync(file) ? fs.readFileSync(file) : null;
    return [key, bytes ? { bytes: bytes.length, sha256: hash(bytes) } : null];
  }).sort(([a], [b]) => a.localeCompare(b)));
}

function isolate(home, codexHome) {
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.CODEX_HOME = codexHome;
  assert.equal(os.homedir(), home, 'packaged modules and child validators must use the isolated home');
}

async function main() {
  assert.equal(process.platform, 'win32', 'this runtime fixture currently targets Windows');
  const args = parseArgs(process.argv.slice(2));
  const manifestVersion = json(path.join(__dirname, '..', 'vscode-extension', 'package.json')).version;
  const extension = args['--extension-dir'] ? path.resolve(args['--extension-dir'])
    : path.join(os.homedir(), '.vscode', 'extensions', `local.permission-wildcarding-${manifestVersion}`);
  assert.ok(fs.existsSync(path.join(extension, 'extension.js')), `installed extension missing: ${extension}`);
  const installedVersion = json(path.join(extension, 'package.json')).version;
  if (!args['--extension-dir']) assert.equal(installedVersion, manifestVersion, 'installed extension version differs from manifest');
  const customLayout = args['--codex-layout'] === 'custom-override';
  const evidenceRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-shared-runtime-'));
  const reportPath = path.join(evidenceRoot, 'evidence.json');
  const started = Date.now();
  const report = { status: 'running', boundary: BOUNDARY, extension, installedVersion,
    explicitExtensionOverride: !!args['--extension-dir'], codexLayout: customLayout ? 'custom-override' : 'default',
    startedAt: new Date(started).toISOString(), isolatedStateRetained: true,
    evidenceRoot, moduleHashes: subjectHashes(extension),
    harnessHashes: { shared: fileHash(__filename), runtime: fileHash(path.join(__dirname, 'check-codex-runtime.js')) },
    groups: [], runtimeCases: [] };
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  let createAutoLearnManager;
  function saveReport() { fs.writeFileSync(reportPath, `${JSON.stringify(report, null, 2)}\n`); }
  function fixture(name, samePrefix = false) {
    const root = path.join(evidenceRoot, 'isolated-state', name);
    const home = path.join(root, 'home');
    const codexHome = customLayout ? path.join(root, 'custom-codex') : path.join(home, '.codex');
    const workspaces = ['a', 'b'].map((letter) => path.join(root, `workspace-${letter}`));
    for (const dir of [codexHome, path.join(home, '.claude'), ...workspaces]) fs.mkdirSync(dir, { recursive: true });
    isolate(home, codexHome);
    createAutoLearnManager ||= require(path.join(extension, 'src', 'auto-learn-manager.js')).createAutoLearnManager;
    const suffix = crypto.randomBytes(5).toString('hex');
    const commandA = `acolyte-shared-a-${suffix}.cmd`;
    const commandB = samePrefix ? commandA : `acolyte-shared-b-${suffix}.cmd`;
    const shellWitness = `acolyte-shared-executed-${suffix}`;
    const userWitness = `acolyte-shared-user-instructions-${suffix}`;
    const shadowedWitness = `acolyte-shared-shadowed-instructions-${suffix}`;
    const instructions = path.join(codexHome, customLayout ? 'AGENTS.override.md' : 'AGENTS.md');
    fs.writeFileSync(instructions, `# User instructions\n${userWitness}\n`);
    if (customLayout) fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), `# Inactive base\n${shadowedWitness}\n`);
    const settings = path.join(home, '.claude', 'settings.json');
    fs.writeFileSync(settings, '{"fixtureUserSetting":"preserve"}\r\n');
    const rules = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    const originalRules = `# User-owned policy bytes ${suffix}\r\nprefix_rule(pattern = ["acolyte-user-${suffix}.cmd"], decision = "prompt")\r\n`;
    fs.writeFileSync(rules, originalRules);
    const preserved = Object.fromEntries([settings, instructions, ...(customLayout ? [path.join(codexHome, 'AGENTS.md')] : [])]
      .map((file) => [file, fileHash(file)]));
    const managers = workspaces.map((workspaceRoot, index) => {
      const command = index ? commandB : commandA;
      fs.writeFileSync(path.join(workspaceRoot, command), `@echo off\r\necho ${shellWitness}\r\n`);
      return createAutoLearnManager({ home, codexHome, workspaceRoot, codexRulesPath: rules,
        claudeSettingsPath: null, managedPolicyPath: path.join(home, '.claude', 'managed-settings.json'),
        codexExecutable: args['--codex'] || 'codex', mode: 'recommend', threshold: 3,
        historyScanner: () => ({ observations: [1, 2, 3].map((n) => ({
          id: `${name}-${index}-synthetic-${n}`, source: 'codex', tool: 'PowerShell',
          command: `${command} allowed`, status: 'success', cwd: workspaceRoot,
        })), cursors: {}, files: [{ source: 'codex', mode: 'full' }] }),
      });
    });
    assert.notEqual(managers[0].paths.state, managers[1].paths.state, 'workspace evidence must have distinct state files');
    assert.equal(managers[0].paths.lock, managers[1].paths.lock, 'writers must share the policy lock');
    assert.equal(managers[0].paths.codexRules, managers[1].paths.codexRules, 'writers must share the exact policy target');
    const contexts = workspaces.map((workspace, index) => createRuntimeContext({
      extensionDir: extension, workspace, home, codexHome, customLayout,
      commandName: index ? commandB : commandA, shellWitness, codexExecutable: args['--codex'] || 'codex',
      approvalDecision: 'decline', instructionWitnesses: { user: userWitness,
        shadowed: shadowedWitness, gate: `acolyte-shared-absent-gate-${suffix}` },
    }));
    return { name, root, home, codexHome, rules, originalRules, preserved, managers, contexts, commands: [commandA, commandB] };
  }

  function preserved(f) {
    assert.ok(fs.readFileSync(f.rules, 'utf8').startsWith(f.originalRules), `${f.name}: user-owned policy bytes must remain intact`);
    for (const [file, expected] of Object.entries(f.preserved)) assert.equal(fileHash(file), expected,
      `${f.name}: user-owned instruction/settings file changed: ${file}`);
    if (customLayout) assert.equal(fs.existsSync(path.join(f.home, '.codex')), false, `${f.name}: custom layout must not create default Codex home`);
  }

  function grant(f, index, group) {
    const manager = f.managers[index];
    manager.scan();
    const candidates = manager.listCandidates();
    assert.equal(candidates.length, 1, `${f.name}: synthetic scanner must produce exactly one candidate`);
    const candidate = candidates[0];
    assert.deepEqual(candidate.prefix, [f.commands[index]], `${f.name}: reviewed prefix must be the unique executable`);
    assert.equal(candidate.counts.success, 3, `${f.name}: eligibility comes from exactly three labelled synthetic successes`);
    assert.equal(candidate.baseAutoSafe, false, `${f.name}: custom executable must require manual review`);
    assert.equal(candidate.meetsThreshold, true, `${f.name}: reviewed candidate must meet the threshold`);
    const result = manager.applyCodex({ keys: [candidate.key], includeReviewed: true,
      expectedFingerprints: { [candidate.key]: candidate.fingerprint } });
    assert.equal(result.appliedCount, 1, `${f.name}: manager must apply exactly one reviewed grant`);
    const state = json(manager.paths.state);
    assert.ok(state.reviewed.codex.includes(candidate.key), `${f.name}: workspace must persist its own reviewed Codex grant`);
    assert.ok(state.lastApplication, `${f.name}: grant must create an Undo transaction`);
    preserved(f);
    group.grants.push({ workspace: index ? 'B' : 'A', command: f.commands[index],
      candidate: candidate.key, fingerprint: candidate.fingerprint, appliedCount: result.appliedCount,
      statePath: manager.paths.state, stateHash: fileHash(manager.paths.state),
      claimsPath: manager.paths.codexClaims || null, policyHash: fileHash(f.rules) });
    saveReport();
    return candidate;
  }

  async function check(f, index, label, allowed) {
    let result;
    try { result = await runtimeCase(f.contexts[index], `${f.name}/${label}`, 'allowed', false); }
    catch (error) {
      if (error.runtimeEvidence) report.runtimeCases.push({ ...error.runtimeEvidence, expected: allowed ? 'allow' : 'prompt', passed: false });
      throw error;
    }
    result.expected = allowed ? 'allow' : 'prompt';
    result.passed = false;
    report.runtimeCases.push(result);
    if (allowed) assertAllowed(result);
    else assertDeclined(result);
    preserved(f);
    result.passed = true;
    console.log(`PASS ${result.name}: approvals=${result.approvals}, command=${result.commandItems[0].status}`);
    saveReport();
  }

  function sharedUndo(f, group) {
    const before = sharedSnapshot(f);
    const secondState = fs.readFileSync(f.managers[1].paths.state);
    let result;
    let refusal;
    try { result = f.managers[0].undo(); }
    catch (error) { refusal = error; }
    if (refusal) {
      assert.match(String(refusal.message), CONFLICT, `${f.name}: refusal must identify a policy or shared-ownership conflict`);
      assert.deepEqual(sharedSnapshot(f), before, `WITNESS ${f.name}: refused Undo must preserve policy and every workspace state/claims byte`);
      group.undo = { outcome: 'refused', message: refusal.message, before, after: sharedSnapshot(f) };
    } else {
      assert.equal(result?.undone, true, `${f.name}: successful Undo must actually report undone`);
      assert.equal(json(f.managers[0].paths.state).lastApplication, null, `${f.name}: successful Undo must clear its transaction`);
      group.undo = { outcome: 'undone', result, before, after: sharedSnapshot(f) };
    }
    assert.deepEqual(fs.readFileSync(f.managers[1].paths.state), secondState,
      `WITNESS ${f.name}: Undo must not rewrite the other workspace state`);
    preserved(f);
    saveReport();
    return !!refusal;
  }

  async function group(name, operation) {
    const result = { name, status: 'running', grants: [], startedAt: new Date().toISOString() };
    report.groups.push(result);
    saveReport();
    try { await operation(result); result.status = 'passed'; }
    catch (error) { result.status = 'failed'; result.failure = error.message; throw error; }
    finally { result.finishedAt = new Date().toISOString(); saveReport(); }
  }

  try {
    // Construct an isolated profile before requiring any subject module.
    const initial = fixture('single-workspace');
    const { commandLaunch } = require(path.join(extension, 'src', 'exec-resolve.js'));
    const launch = commandLaunch(args['--codex'] || 'codex', ['--version']);
    assert.ok(launch.resolved, 'Codex executable is not reachable');
    const version = spawnSync(launch.file, launch.args, { ...launch.options, windowsHide: true, encoding: 'utf8', timeout: 10000 });
    assert.equal(version.status, 0, 'Codex version probe failed');
    report.codexVersion = version.stdout.trim();
    console.log(`Subject: AI Acolyte ${installedVersion}; ${report.codexVersion}; ${extension}`);
    console.log(BOUNDARY);
    console.log(`Codex layout: ${report.codexLayout}; evidence: ${reportPath}`);
    await group('single-workspace-removal', async (record) => {
      await check(initial, 0, 'baseline-prompts', false);
      grant(initial, 0, record);
      await check(initial, 0, 'reviewed-grant-allows', true);
      const result = initial.managers[0].undo();
      assert.equal(result.undone, true, 'single-workspace Undo must succeed');
      assert.equal(fs.readFileSync(initial.rules, 'utf8'), initial.originalRules, 'single-workspace Undo must restore exact original policy bytes');
      const state = json(initial.managers[0].paths.state);
      assert.equal(state.lastApplication, null, 'single-workspace Undo must clear its transaction');
      assert.deepEqual(state.reviewed.codex, [], 'single-workspace Undo must clear its reviewed grant');
      record.undo = { outcome: 'undone', result, after: sharedSnapshot(initial) };
      await check(initial, 0, 'undo-restores-prompt', false);
    });
    await group('distinct-workspace-grants', async (record) => {
      const f = fixture('distinct');
      await check(f, 0, 'workspace-a-baseline-prompts', false);
      await check(f, 1, 'workspace-b-baseline-prompts', false);
      grant(f, 0, record);
      await check(f, 0, 'workspace-a-grant-allows', true);
      const firstState = fs.readFileSync(f.managers[0].paths.state);
      grant(f, 1, record);
      assert.deepEqual(fs.readFileSync(f.managers[0].paths.state), firstState, 'workspace B grant must not rewrite workspace A evidence');
      await check(f, 1, 'workspace-b-grant-allows', true);
      await check(f, 0, 'WITNESS-workspace-a-survives-workspace-b-grant', true);
      const refused = sharedUndo(f, record);
      await check(f, 1, 'WITNESS-workspace-b-survives-workspace-a-undo', true);
      await check(f, 0, refused ? 'refused-undo-retains-workspace-a-grant' : 'successful-undo-restores-workspace-a-prompt', refused);
    });
    await group('identical-prefix-shared-ownership', async (record) => {
      const f = fixture('identical', true);
      await check(f, 0, 'shared-prefix-baseline-prompts', false);
      grant(f, 0, record);
      await check(f, 0, 'workspace-a-grant-allows', true);
      const policyBeforeSecond = fs.readFileSync(f.rules);
      const stateBeforeSecond = fs.readFileSync(f.managers[0].paths.state);
      grant(f, 1, record);
      assert.deepEqual(fs.readFileSync(f.rules), policyBeforeSecond,
        'identical-prefix witness requires unchanged policy bytes after workspace B claims the same rule');
      assert.deepEqual(fs.readFileSync(f.managers[0].paths.state), stateBeforeSecond,
        'identical-prefix workspace B grant must not rewrite workspace A evidence');
      await check(f, 1, 'workspace-b-shared-grant-allows', true);
      sharedUndo(f, record);
      await check(f, 1, 'WITNESS-identical-prefix-survives-workspace-a-undo', true);
    });
    assert.equal(report.runtimeCases.length, 14, 'all fourteen fresh-process witnesses must execute');
    assert.equal(report.runtimeCases.filter((item) => item.passed).length, 14, 'all fourteen runtime witnesses must pass');
    report.status = 'passed';
  } catch (error) {
    report.status = 'failed';
    report.failure = String(error.message || error);
    process.exitCode = 1;
  } finally {
    try {
      assert.deepEqual(subjectHashes(extension), report.moduleHashes, 'packaged subject changed during runtime validation');
      assert.equal(fileHash(__filename), report.harnessHashes.shared, 'shared runtime harness changed during validation');
      assert.equal(fileHash(path.join(__dirname, 'check-codex-runtime.js')), report.harnessHashes.runtime, 'runtime helper changed during validation');
      report.subjectHashesUnchanged = true;
      report.loadedSubjectModules = Object.keys(require.cache).filter((file) => file.startsWith(extension + path.sep))
        .map((file) => ({ file: path.relative(extension, file).replace(/\\/g, '/'), sha256: fileHash(file) }));
      assert.ok(report.loadedSubjectModules.some((item) => item.file === 'src/auto-learn-manager.js'), 'subject manager must have executed');
    } catch (error) {
      report.integrityFailure = String(error.message || error);
      report.status = 'failed';
      process.exitCode = 1;
    }
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
    report.finishedAt = new Date().toISOString();
    report.elapsedMs = Date.now() - started;
    report.runtimePasses = report.runtimeCases.filter((item) => item.passed).length;
    report.groupPasses = report.groups.filter((item) => item.status === 'passed').length;
    saveReport();
    console.log(`${report.status.toUpperCase()}: ${report.groupPasses}/3 groups, ${report.runtimePasses}/14 fresh runtime cases; evidence ${reportPath}`);
    if (report.failure) console.error(report.failure);
    if (report.integrityFailure) console.error(report.integrityFailure);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.message || error); process.exitCode = 1; });
