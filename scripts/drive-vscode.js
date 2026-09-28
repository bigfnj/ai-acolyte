#!/usr/bin/env node
'use strict';

// Launch the installed VS Code application with the selected packaged extension,
// real vscode APIs, and an isolated user profile. No API/module mocking is used.
// The extension-host test reports files and policy outcomes, not UI appearance.
//
// node scripts/drive-vscode.js [version] [--extension-dir packaged-directory]
//   [--codex-layout default|custom-override] [--review-runtime yes] [--dashboard-ui yes] [--codex-prune yes]
//   [--codex-restore yes] [--codex-derived yes] [--features-only yes] [--approvals-only yes] [--mcp-only yes] [--recall-only yes] [--native-gates-only yes]
// Windows-only launcher: Start-Process keeps the test instance hidden and separate
// from the user's running editor. The test instance exits when acceptance ends.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');

assert.equal(process.platform, 'win32', 'drive-vscode currently requires the Windows Start-Process launcher');
const repo = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const version = args[0] && !args[0].startsWith('--') ? args.shift()
  : JSON.parse(fs.readFileSync(path.join(repo, 'vscode-extension', 'package.json'), 'utf8')).version;
const options = {};
while (args.length) {
  const option = args.shift();
  assert.ok(['--extension-dir', '--codex-layout', '--review-runtime', '--dashboard-ui', '--codex-prune', '--codex-restore', '--codex-derived', '--features-only', '--approvals-only', '--mcp-only', '--recall-only', '--native-gates-only'].includes(option) && args.length && !args[0].startsWith('--'),
    'usage: node scripts/drive-vscode.js [version] [--extension-dir extension-directory] [--codex-layout default|custom-override] [--review-runtime yes] [--dashboard-ui yes] [--codex-prune yes] [--codex-restore yes] [--codex-derived yes] [--features-only yes] [--approvals-only yes] [--mcp-only yes] [--recall-only yes] [--native-gates-only yes]');
  assert.equal(options[option], undefined, `duplicate option: ${option}`);
  options[option] = args.shift();
}
const codexLayout = options['--codex-layout'] || 'default';
assert.ok(['default', 'custom-override'].includes(codexLayout), `unsupported Codex layout: ${codexLayout}`);
assert.ok(!options['--review-runtime'] || options['--review-runtime'] === 'yes', '--review-runtime accepts only yes');
const reviewRuntime = options['--review-runtime'] === 'yes';
assert.ok(!options['--dashboard-ui'] || options['--dashboard-ui'] === 'yes', '--dashboard-ui accepts only yes');
const dashboardUi = options['--dashboard-ui'] === 'yes';
assert.ok(!dashboardUi || reviewRuntime, '--dashboard-ui yes requires --review-runtime yes');
assert.ok(!options['--codex-prune'] || options['--codex-prune'] === 'yes', '--codex-prune accepts only yes');
const codexPrune = options['--codex-prune'] === 'yes';
assert.ok(!codexPrune || reviewRuntime, '--codex-prune yes requires --review-runtime yes');
assert.ok(!options['--codex-restore'] || options['--codex-restore'] === 'yes', '--codex-restore accepts only yes');
const codexRestore = options['--codex-restore'] === 'yes';
assert.ok(!codexRestore || reviewRuntime, '--codex-restore yes requires --review-runtime yes');
assert.ok(!options['--codex-derived'] || options['--codex-derived'] === 'yes', '--codex-derived accepts only yes');
const codexDerived = options['--codex-derived'] === 'yes';
assert.ok(!codexDerived || reviewRuntime, '--codex-derived yes requires --review-runtime yes');
assert.ok(!options['--features-only'] || options['--features-only'] === 'yes', '--features-only accepts only yes');
const featuresOnly = options['--features-only'] === 'yes';
assert.ok(!options['--approvals-only'] || options['--approvals-only'] === 'yes', '--approvals-only accepts only yes');
const approvalsOnly = options['--approvals-only'] === 'yes';
assert.ok(!options['--mcp-only'] || options['--mcp-only'] === 'yes', '--mcp-only accepts only yes');
const mcpOnly = options['--mcp-only'] === 'yes';
assert.ok(!options['--recall-only'] || options['--recall-only'] === 'yes', '--recall-only accepts only yes');
const recallOnly = options['--recall-only'] === 'yes';
assert.ok(!options['--native-gates-only'] || options['--native-gates-only'] === 'yes', '--native-gates-only accepts only yes');
const nativeGatesOnly = options['--native-gates-only'] === 'yes';
assert.ok(!nativeGatesOnly || (reviewRuntime && codexLayout === 'custom-override'), '--native-gates-only requires actual UI and custom override layout');
assert.ok(!nativeGatesOnly || !(recallOnly || mcpOnly || featuresOnly || approvalsOnly || dashboardUi || codexPrune || codexRestore || codexDerived), '--native-gates-only runs its focused groups separately');
assert.ok(!recallOnly || reviewRuntime, '--recall-only yes requires --review-runtime yes');
assert.ok(!recallOnly || !(mcpOnly || featuresOnly || approvalsOnly || dashboardUi || codexPrune || codexRestore || codexDerived), '--recall-only runs its focused groups separately');
let recallEnvironment = {};
if (recallOnly) {
  const toolboxManifest = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'DevToolbox', 'toolbox-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
  const python = toolboxManifest.python?.executable;
  assert.ok(python && path.isAbsolute(python) && fs.existsSync(python), 'semantic acceptance needs the existing toolbox CPU Python');
  const toolbox = path.resolve(python, '..', '..', '..', '..');
  assert.equal(path.resolve(toolbox, 'python', '.venv', 'Scripts', 'python.exe').toLowerCase(), path.resolve(python).toLowerCase());
  const modelDir = process.env.RECALL_MODEL_DIR || path.join(repo, 'memory', 'models');
  for (const name of ['bge-small.onnx', 'bge-small.vocab.txt']) assert.ok(path.isAbsolute(modelDir) && fs.existsSync(path.join(modelDir, name)), 'semantic acceptance needs existing local CPU assets; it never downloads');
  recallEnvironment = { RECALL_MODEL_DIR: modelDir, TOOLBOX_PYTHON: python, CODEX_TOOLBOX: toolbox,
    CUDA_VISIBLE_DEVICES: '-1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1', ACOLYTE_ACCEPTANCE_RECALL_ONLY: '1' };
}
assert.ok(!mcpOnly || reviewRuntime, '--mcp-only yes requires --review-runtime yes');
assert.ok(!mcpOnly || !(featuresOnly || approvalsOnly || dashboardUi || codexPrune || codexRestore || codexDerived), '--mcp-only runs its focused groups separately');
assert.ok(!approvalsOnly || reviewRuntime, '--approvals-only yes requires --review-runtime yes');
assert.ok(!approvalsOnly || !(featuresOnly || dashboardUi || codexPrune || codexRestore || codexDerived), '--approvals-only runs its focused groups separately');
assert.ok(!featuresOnly || reviewRuntime, '--features-only yes requires --review-runtime yes');
assert.ok(!featuresOnly || !(dashboardUi || codexPrune || codexRestore || codexDerived), '--features-only runs its focused groups separately');
const extensionDir = options['--extension-dir'] ? path.resolve(options['--extension-dir'])
  : path.join(os.homedir(), '.vscode', 'extensions', `local.permission-wildcarding-${version}`);
assert.ok(fs.existsSync(path.join(extensionDir, 'extension.js')), `packaged extension is missing: ${extensionDir}`);
const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'package.json'), 'utf8'));
assert.equal(manifest.version, version, 'the selected packaged version differs from the requested version');
const { resolveExecutable } = require(path.join(extensionDir, 'src', 'exec-resolve.js'));
const codeCommand = resolveExecutable('code');
assert.ok(codeCommand, 'VS Code is not installed or its code command cannot be resolved');
const codeExecutable = path.resolve(path.dirname(codeCommand), '..', 'Code.exe');
assert.ok(fs.existsSync(codeExecutable), `VS Code application is missing: ${codeExecutable}`);
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-vscode-drive-'));
const home = path.join(root, 'home');
const codexHome = codexLayout === 'custom-override' ? path.join(root, 'custom-codex') : path.join(home, '.codex');
const codexInstructions = path.join(codexHome, codexLayout === 'custom-override' ? 'AGENTS.override.md' : 'AGENTS.md');
const workspace = path.join(root, 'workspace');
const userData = path.join(root, 'user-data');
const extensions = path.join(root, 'extensions');
const report = path.join(root, 'acceptance.json');
const reviewProgress = path.join(root, 'review-progress.json');
const rendererReport = path.join(root, 'renderer.json');
const windowTitle = path.basename(root);
let rendererPort;
if (reviewRuntime) {
  const probe = spawnSync(process.execPath, ['-e', [
    "const server = require('node:net').createServer();",
    "server.listen(0, '127.0.0.1', () => { console.log(server.address().port); server.close(); });",
  ].join('\n')], { encoding: 'utf8', windowsHide: true, timeout: 5000 });
  assert.ifError(probe.error);
  assert.equal(probe.status, 0, 'cannot choose an isolated renderer debugging port');
  rendererPort = Number(probe.stdout.trim());
  assert.ok(Number.isInteger(rendererPort) && rendererPort > 0, 'invalid renderer debugging port');
}
for (const dir of [home, workspace, extensions, path.join(userData, 'User'),
  path.join(home, '.claude'), path.join(codexHome, 'rules'), path.join(codexHome, 'sessions')]) {
  fs.mkdirSync(dir, { recursive: true });
}
const ownInstructions = '# Fixture user instructions\nKeep this user-owned line.\n';
for (const file of [path.join(home, '.claude', 'CLAUDE.md'), codexInstructions]) {
  fs.writeFileSync(file, ownInstructions);
}
if (codexLayout === 'custom-override') {
  fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), [
    '# Inactive base instructions', 'This base file must stay byte-identical.', '',
    '<!-- BEGIN permission-wildcarding: shell style (managed) -->',
    'Stale shell guidance in the inactive base file.', '<!-- END permission-wildcarding: shell style -->', '',
    '<!-- BEGIN permission-wildcarding: memory gates (managed) -->',
    'Stale memory gate in the inactive base file.', '<!-- END permission-wildcarding: memory gates -->', '',
  ].join('\n'));
  assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'custom fixture must not create the default Codex directory');
}
fs.writeFileSync(path.join(home, '.claude', 'gates.generated.md'),
  '## Fixture standing order\nVerify the requested behavior before reporting it.\n');
fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
  JSON.stringify({ permissions: { allow: [], deny: [], ask: [] } }, null, 2) + '\n');
const rulesFile = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
const originalRules = '# Fixture user policy remains owned by the user\n';
fs.writeFileSync(rulesFile, originalRules);
const records = [{ type: 'session_meta', payload: { id: 'real-vscode-codex', cwd: workspace } }];
for (let i = 0; i < 4; i += 1) {
  const call_id = `real-vscode-${i}`;
  records.push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id,
    input: `const result = await tools.exec_command(${JSON.stringify({ cmd: 'git status --short', workdir: workspace })});`,
  } });
  records.push({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output: 'Exit code: 0\n' } });
}
// Keep new evidence outside the history roots until its own explicit Scan Now.
// Otherwise the migration scan could accidentally satisfy that later check.
fs.writeFileSync(path.join(root, 'fresh-history.jsonl'),
  records.map((item) => JSON.stringify(item)).join('\n') + '\n');
const pending = [{ type: 'session_meta', payload: { id: 'legacy-vscode-codex', cwd: workspace } }];
for (let i = 0; i < 3; i += 1) {
  const call_id = `legacy-vscode-${i}`;
  pending.push({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id,
    input: `const result = await tools.exec_command(${JSON.stringify({ cmd: 'git ls-files', workdir: workspace })}); text(result);`,
  } });
  pending.push({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id, output: [
    { type: 'text', text: 'Script completed' },
    { type: 'text', text: JSON.stringify({ session_id: 700 + i, output: 'running' }) },
  ] } });
}
fs.writeFileSync(path.join(codexHome, 'sessions', 'rollout-legacy-vscode.jsonl'),
  pending.map((item) => JSON.stringify(item)).join('\n') + '\n');
// Fabricate the old parser's success classification to construct a realistic v1
// grant and undo transaction. Only fixture preparation injects a scanner; the
// real extension host below always executes the packaged production scanner.
const { scanHistoryFiles } = require(path.join(extensionDir, 'src', 'history-adapters.js'));
const { createAutoLearnManager } = require(path.join(extensionDir, 'src', 'auto-learn-manager.js'));
const parsed = scanHistoryFiles({ codexRoots: [path.join(codexHome, 'sessions')], platform: 'win32' });
assert.equal(parsed.observations.length, 3, 'legacy fixture must contain three pending subprocesses');
assert.ok(parsed.observations.every((item) => item.status === 'unknown'), 'current parser must classify the pending fixture as unknown');
const seed = createAutoLearnManager({ home, codexHome, workspaceRoot: workspace, mode: 'recommend',
  codexRulesPath: rulesFile, historyScanner: () => ({ ...parsed,
    observations: parsed.observations.map((item) => ({ ...item, status: 'success' })),
  }) });
seed.scan();
const seededApplication = seed.applyCodex();
assert.equal(seededApplication.appliedCount, 1,
  `legacy fixture must start with one real Codex grant: ${JSON.stringify({ application: seededApplication, candidates: seed.listCandidates() })}`);
const stateDir = path.join(home, '.claude', 'wildcarding');
const stateFiles = fs.readdirSync(stateDir).filter((file) => /^auto-learn-state.*\.json$/.test(file));
assert.equal(stateFiles.length, 1);
const stateFile = path.join(stateDir, stateFiles[0]);
const legacy = JSON.parse(fs.readFileSync(stateFile, 'utf8'));
const legacyCandidate = Object.values(legacy.candidates).find((item) => item.prefix.join(' ') === 'git ls-files');
assert.ok(legacyCandidate && legacyCandidate.counts.success === 3);
assert.ok(legacy.applied.codex.includes(legacyCandidate.key));
assert.ok(legacy.lastApplication, 'legacy fixture must retain a usable undo transaction');
legacy.version = 1;
// Version 1 predates the shared Codex ownership ledger. Retain the real policy
// snapshot but remove this newer transaction target from the simulated old state.
legacy.lastApplication.targets = legacy.lastApplication.targets.filter((target) => target.kind !== 'codex-claims');
if (seed.paths.codexClaims && fs.existsSync(seed.paths.codexClaims)) {
  assert.equal(path.dirname(seed.paths.codexClaims), stateDir, 'fixture ledger must stay inside the owned state directory');
  fs.unlinkSync(seed.paths.codexClaims);
}
assert.ok(legacy.lastApplication.targets.some((target) => target.kind === 'codex'));
for (const key of Object.keys(legacy)) {
  if (key.startsWith('codexEvidence') || ['legacyCodexEvidence', 'preservedEvidenceGrants'].includes(key)) delete legacy[key];
}
for (const item of Object.values(legacy.candidates)) delete item.sourceCounts;
fs.writeFileSync(stateFile, JSON.stringify(legacy, null, 2) + '\n');
fs.writeFileSync(path.join(root, 'migration-fixture.json'), JSON.stringify({ key: legacyCandidate.key,
  originalRules, grantedRules: fs.readFileSync(rulesFile, 'utf8'),
  applied: legacy.applied, reviewed: legacy.reviewed, lastApplication: legacy.lastApplication,
}, null, 2) + '\n');
fs.writeFileSync(path.join(userData, 'User', 'settings.json'), JSON.stringify({
  'telemetry.telemetryLevel': 'off',
  'extensions.autoUpdate': false,
  'update.mode': 'none',
  'window.restoreWindows': 'none',
  'workbench.startupEditor': 'none',
  ...(reviewRuntime ? { 'window.title': windowTitle, 'window.dialogStyle': 'custom' } : {}),
  'permissionWildcarding.guidance.enabled': false,
  'permissionWildcarding.gates.enabled': false,
  // Manual Scan Now bypasses this switch. Keep startup's background scan from
  // satisfying the explicit command's acceptance check before it is invoked.
  'permissionWildcarding.autoLearn.enabled': false,
  'permissionWildcarding.autoLearn.mode': 'recommend',
  'permissionWildcarding.autoLearn.intervalMinutes': 60,
}, null, 2));

const launchArgs = [
  `--extensionDevelopmentPath=${extensionDir}`,
  ...(reviewRuntime
    ? [`--extensionDevelopmentPath=${path.join(__dirname, 'vscode-acceptance')}`]
    : [`--extensionTestsPath=${path.join(__dirname, 'vscode-acceptance', 'index.js')}`]),
  `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`,
  '--new-window', '--disable-extensions', '--disable-workspace-trust',
  '--disable-telemetry', '--disable-gpu', '--skip-welcome', '--skip-release-notes', workspace,
  ...(reviewRuntime ? [`--remote-debugging-port=${rendererPort}`, '--remote-debugging-address=127.0.0.1'] : []),
];
const psQuote = (text) => `'${String(text).replace(/'/g, "''")}'`;
const argumentLine = launchArgs.map((arg) => `"${arg.replace(/"/g, '""')}"`).join(' ');
const launchScript = path.join(root, 'launch.ps1');
const rendererArgs = [path.join(__dirname, 'vscode-acceptance', 'renderer.js'),
  '--port', String(rendererPort), '--progress', reviewProgress, '--report', rendererReport,
  '--window-title', windowTitle].map((arg) => `"${arg.replace(/"/g, '""')}"`).join(' ');
const timeout = reviewRuntime ? 240000 : 90000;
fs.writeFileSync(launchScript, [
  "$ErrorActionPreference = 'Stop'",
  ...(reviewRuntime ? [
    `$driver = Start-Process -FilePath 'node' -ArgumentList ${psQuote(rendererArgs)} -PassThru -WindowStyle Hidden -RedirectStandardOutput ${psQuote(path.join(root, 'renderer.stdout.log'))} -RedirectStandardError ${psQuote(path.join(root, 'renderer.stderr.log'))}`,
    '$null = $driver.Handle',
    'try {',
  ] : []),
  `$child = Start-Process -FilePath ${psQuote(codeExecutable)} -ArgumentList ${psQuote(argumentLine)} -PassThru -WindowStyle Hidden -RedirectStandardOutput ${psQuote(path.join(root, 'vscode.stdout.log'))} -RedirectStandardError ${psQuote(path.join(root, 'vscode.stderr.log'))}`,
  // Windows PowerShell 5.1 must retain the process handle before it exits; without
  // this access, ExitCode can remain null even after WaitForExit returned true.
  '$null = $child.Handle',
  `if (-not $child.WaitForExit(${timeout})) {`,
  // Stop only this spawned test instance and its descendants, including workers.
  '  taskkill.exe /PID $child.Id /T /F',
  `  throw 'VS Code acceptance timed out after ${timeout / 1000} seconds.'`,
  '}',
  ...(reviewRuntime ? [
    'if (-not $driver.WaitForExit(10000)) { Stop-Process -Id $driver.Id -Force }',
  ] : []),
  'if ($null -eq $child.ExitCode) { exit 1 }',
  'exit $child.ExitCode',
  ...(reviewRuntime ? [
    '} finally {',
    '  if (-not $driver.HasExited) { Stop-Process -Id $driver.Id -Force }',
    '}',
  ] : []),
].join('\r\n') + '\r\n');
const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome,
  ...recallEnvironment,
  ACOLYTE_ACCEPTANCE_HOME: home, ACOLYTE_ACCEPTANCE_REPORT: report,
  ACOLYTE_ACCEPTANCE_EXTENSION: extensionDir, ACOLYTE_ACCEPTANCE_VERSION: version,
  ACOLYTE_ACCEPTANCE_CODEX_HOME: codexHome, ACOLYTE_ACCEPTANCE_CODEX_LAYOUT: codexLayout,
  ...(reviewRuntime ? { ACOLYTE_ACCEPTANCE_REVIEW_RUNTIME: '1', ACOLYTE_ACCEPTANCE_OWNED_HOST: '1',
    ACOLYTE_ACCEPTANCE_REVIEW_PROGRESS: reviewProgress } : {}),
  ...(dashboardUi ? { ACOLYTE_ACCEPTANCE_DASHBOARD_UI: '1' } : {}),
  ...(codexPrune ? { ACOLYTE_ACCEPTANCE_CODEX_PRUNE: '1' } : {}),
  ...(codexRestore ? { ACOLYTE_ACCEPTANCE_CODEX_RESTORE: '1' } : {}),
  ...(codexDerived ? { ACOLYTE_ACCEPTANCE_CODEX_DERIVED: '1' } : {}),
  ...(featuresOnly ? { ACOLYTE_ACCEPTANCE_FEATURES_ONLY: '1' } : {}),
  ...(approvalsOnly ? { ACOLYTE_ACCEPTANCE_APPROVALS_ONLY: '1' } : {}),
  ...(mcpOnly ? { ACOLYTE_ACCEPTANCE_MCP_ONLY: '1' } : {}),
  ...(nativeGatesOnly ? { ACOLYTE_ACCEPTANCE_NATIVE_GATES_ONLY: '1' } : {}),
};
delete env.ELECTRON_RUN_AS_NODE;
console.log(`Real VS Code acceptance: ${extensionDir}`);
console.log(`Isolated profile and logs: ${root}`);
console.log(`Codex layout: ${codexLayout}; CODEX_HOME=${codexHome}`);
if (reviewRuntime) console.log(`${featuresOnly || approvalsOnly || mcpOnly || recallOnly || nativeGatesOnly ? 'Native UI automation' : 'Review/runtime acceptance'} enabled; renderer restricted to ${windowTitle} on loopback port ${rendererPort}`);
if (dashboardUi) console.log('Dashboard UI acceptance enabled for the owned extension webview.');
if (codexPrune) console.log('Codex inventory and removal UI acceptance enabled in the isolated Codex home.');
if (codexRestore) console.log('Codex rule restore UI acceptance enabled in the isolated Codex home.');
if (codexDerived) console.log('Codex derived-guidance UI and fresh-process instruction acceptance enabled.');
if (featuresOnly) console.log('Focused Codex hook and native-memory UI acceptance enabled.');
if (approvalsOnly) console.log('Focused reviewed Codex approvals and project-import UI acceptance enabled.');
if (mcpOnly) console.log('Focused exact Codex MCP history, approval, Undo and recovery UI acceptance enabled.');
if (recallOnly) console.log('Focused Codex semantic memory search, rebuild and explicit keyword fallback UI acceptance enabled.');
if (nativeGatesOnly) console.log('Focused native Codex gate review, automatic refresh and saved MCP receipt UI acceptance enabled.');
const launched = spawnSync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', launchScript],
  { env, cwd: root, encoding: 'utf8', windowsHide: true, timeout: timeout + 20000 });
if (launched.stdout) process.stdout.write(launched.stdout);
if (launched.stderr) process.stderr.write(launched.stderr);
if (!fs.existsSync(report)) {
  console.error(`FAIL: VS Code did not produce an acceptance report; launcher status ${launched.status}, ${launched.error?.message || 'see logs'}`);
  process.exitCode = 1;
} else {
  const result = JSON.parse(fs.readFileSync(report, 'utf8'));
  if (reviewRuntime) {
    result.renderer = fs.existsSync(rendererReport) ? JSON.parse(fs.readFileSync(rendererReport, 'utf8'))
      : { status: 'failed', failure: 'renderer automation did not produce its report' };
    if (result.renderer.status !== 'passed' && !result.results.some((item) => item.verdict === 'FAIL')) result.results.push({ verdict: 'FAIL', name: 'real Review renderer interaction',
      detail: result.renderer.failure || JSON.stringify(result.renderer) });
  }
  if ((launched.status !== 0 || launched.error) && !result.results.some((item) => item.verdict === 'FAIL')) result.results.push({ verdict: 'FAIL',
    name: 'VS Code process exited successfully',
    detail: `launcher status ${launched.status}; ${launched.error?.message || 'see vscode logs'}` });
  result.launcherExitCode = launched.status;
  result.launcherError = launched.error?.message || null;
  fs.writeFileSync(report, JSON.stringify(result, null, 2) + '\n');
  for (const item of result.results) console.log(`  ${item.verdict}  ${item.name}${item.detail ? `\n        ${item.detail}` : ''}`);
  console.log(`Runtime: VS Code ${result.vscodeVersion}, extension-host ${result.nodeVersion}`);
  console.log(`Selected extension file SHA256: ${JSON.stringify(result.artifactHashes)}`);
  console.log(nativeGatesOnly
    ? 'Boundary: actual editor native-gate dashboard, complete review dialogs and filesystem watchers; isolated annotated memory and instructions. Saved MCP receipt prepared through actual config RPC, then inspected through read-only UI. No Codex turn, model inference or live profile changes.'
    : recallOnly
    ? 'Boundary: actual editor dashboard, search input and ranked picker, exact native source selections, CPU semantic cache rebuild and explicit keyword fallback. Existing local CPU assets only; no GPU, model generation, downloads or live memory access.'
    : mcpOnly
    ? 'Boundary: actual editor MCP review controls and config RPC; real MCP history and fresh Codex processes with a harmless local stdio fixture and scripted loopback provider. No inference, credentials or live profile changes.'
    : approvalsOnly
    ? 'Boundary: actual editor dashboard, reviewed rule confirmation, cancellation, stale-source refusal and recovery; staged literal policies and fresh Codex processes in a sibling workspace, scripted loopback responses without inference or credentials.'
    : featuresOnly
    ? 'Boundary: actual editor dashboard, hook configuration dialogs, native memory search/inspection and ambient diagnostics; isolated fixtures. Configuring a hook does not review or activate Codex trust.'
    : reviewRuntime
    ? `Boundary: real extension host, Review and diagnostic UI${dashboardUi ? ', dashboard instruction controls' : ''}${codexPrune ? ', Codex inventory/removal controls' : ''}${codexRestore ? ', Codex restore controls' : ''}${codexDerived ? ', derived-guidance review and loading' : ''}, and fresh Codex processes; scripted loopback responder without inference or credentials. Earlier groups use synthetic history and precompiled gates.`
    : 'Boundary: real extension host and configuration events; synthetic history, fabricated legacy v1 evidence, and precompiled gates. No model/provider session or UI appearance check.');
  const failures = result.results.filter((item) => item.verdict === 'FAIL').length;
  console.log(`real-vscode drive: ${result.results.length - failures} pass, ${failures} fail`);
  process.exitCode = failures || launched.status !== 0 || launched.error ? 1 : 0;
}
