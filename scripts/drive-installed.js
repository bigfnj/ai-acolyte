#!/usr/bin/env node
// Drive the installed extension's command handlers with a SIMULATED VS Code API.
// Workers, disk writes, and Codex execpolicy checks are real. Synthetic transcripts
// live in a temporary home; no model/provider call or live Codex session is started.
// This does not exercise VS Code UI, native watchers, or fresh-session instruction
// loading. The remaining feature validation is tracked in docs/codex-compatibility.md.
//
//   node scripts/drive-installed.js [version]
//   node scripts/drive-installed.js [version] --subject <copied-extension-directory>
//   node scripts/drive-installed.js [version] --extension-dir <packaged-directory>
//   Add --codex-layout custom-override to use an external CODEX_HOME and AGENTS.override.md.
//
// --subject exists for mutation tests against a COPY of the installed artefact. Its
// output explicitly identifies that override; it never substitutes it silently.
//
// Local only, like scripts/smoke.sh and scripts/verify-release.ps1: it needs the VSIX
// actually installed, which CI has no way to arrange.
//
// TWO WARNINGS FOR ANYONE EXTENDING THE STUB, both learned the hard way while writing it.
// The extension CATCHES a subsystem activation failure and keeps going, so "activate()
// completed" passes over a memoryLint that never ran — the subscription count is the tell
// (36 with it dead, 41 alive). And it reports that failure through console.error, not
// through the vscode stub, so the guard added to catch it passed anyway until it watched
// both channels. A stub with a hole makes this harness assert less than it claims, in a
// way that looks like success.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('node:module');
const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');

// The default is the version THIS CHECKOUT would produce, read from the extension
// manifest. It used to be the literal '1.5.2', and that went stale the moment 1.5.3 was
// built and installed: the harness drove the PREVIOUS install and reported 11 pass 0 fail
// against an artefact that did not contain the change being verified. Nothing failed. It
// prints the path it drives, and that line is the only reason it was caught rather than
// believed — which is the argument for printing the subject of a check, not just its
// verdict.
const MANIFEST = path.join(__dirname, '..', 'vscode-extension', 'package.json');
const MANIFEST_VERSION = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')).version;
const args = process.argv.slice(2);
const VERSION = args[0] && !args[0].startsWith('--') ? args.shift() : MANIFEST_VERSION;
const options = {};
while (args.length) {
  const option = args.shift();
  assert.ok(['--subject', '--extension-dir', '--codex-layout'].includes(option) && args.length && !args[0].startsWith('--'),
    'usage: node scripts/drive-installed.js [version] [--extension-dir packaged-directory] [--codex-layout default|custom-override]');
  assert.equal(options[option], undefined, `duplicate option: ${option}`);
  options[option] = args.shift();
}
assert.ok(!(options['--subject'] && options['--extension-dir']), 'use only one extension-directory option');
const codexLayout = options['--codex-layout'] || 'default';
assert.ok(['default', 'custom-override'].includes(codexLayout), `unsupported Codex layout: ${codexLayout}`);
const subject = options['--subject'] || options['--extension-dir'];
const realHome = os.homedir();
const INSTALLED = subject ? path.resolve(subject) : path.join(realHome, '.vscode', 'extensions',
  `local.permission-wildcarding-${VERSION}`);
const entry = path.join(INSTALLED, 'extension.js');

// A missing directory is a LOUD failure that names what IS installed, never a fallback to
// the newest thing lying around. "The build you just made is not installed" is the single
// most useful sentence this script can produce, and falling back would hide exactly that.
if (!fs.existsSync(entry)) {
  const dir = path.join(os.homedir(), '.vscode', 'extensions');
  const prefix = 'local.permission-wildcarding-';
  const found = fs.existsSync(dir)
    ? fs.readdirSync(dir).filter((d) => d.startsWith(prefix)).map((d) => d.slice(prefix.length))
    : [];
  console.error(`no installed extension at ${entry}`);
  console.error(process.argv[2]
    ? `  ${VERSION} was requested explicitly.`
    : `  ${VERSION} is this checkout's manifest version, so the build under test is NOT installed.`);
  console.error(`  installed: ${found.length ? found.join(', ') : '(none)'}`);
  console.error('  fix: run node scripts/package.mjs, then code --install-extension <the VSIX it reports> --force');
  process.exit(2);
}

console.log(`driving ${VERSION}: ${INSTALLED}${subject ? ' (EXPLICIT SUBJECT OVERRIDE)' : ''}`);
console.log(`extension.js SHA256: ${createHash('sha256').update(fs.readFileSync(entry)).digest('hex')}`);
console.log('Boundary: simulated VS Code API; real packaged handlers, workers, files, and Codex execpolicy. No provider session.');

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-installed-drive-'));
const home = path.join(sandbox, 'home');
fs.mkdirSync(home);
const codexHome = codexLayout === 'custom-override' ? path.join(sandbox, 'custom-codex') : path.join(home, '.codex');
const codexInstructions = path.join(codexHome, codexLayout === 'custom-override' ? 'AGENTS.override.md' : 'AGENTS.md');
console.log(`Codex layout: ${codexLayout}; CODEX_HOME=${codexHome}`);
// Workers do not inherit Module._load. Isolate their home and Codex state too.
const originalEnv = Object.fromEntries(['HOME', 'USERPROFILE', 'CODEX_HOME'].map((k) => [k, process.env[k]]));
process.env.HOME = home;
process.env.USERPROFILE = home;
process.env.CODEX_HOME = codexHome;
assert.equal(os.homedir(), home, 'precondition: native home lookup must be isolated before loading the extension');
fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
fs.mkdirSync(codexHome, { recursive: true });
fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
  JSON.stringify({ permissions: { allow: ['Bash(git status *)'], deny: [], ask: [] } }, null, 2) + '\n');
const instructionFiles = [path.join(home, '.claude', 'CLAUDE.md'), codexInstructions];
const ownInstructions = '# Fixture user instructions\nKeep this user-owned line.\n';
for (const file of instructionFiles) fs.writeFileSync(file, ownInstructions);
const inactiveInstructions = '# Inactive base instructions\nThis base file must stay byte-identical.\n';
if (codexLayout === 'custom-override') fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), inactiveInstructions);
const assertInactiveCodexPaths = () => {
  if (codexLayout !== 'custom-override') return;
  assert.equal(fs.existsSync(path.join(home, '.codex')), false, 'extension created the unused default ~/.codex directory');
  assert.equal(fs.readFileSync(path.join(codexHome, 'AGENTS.md'), 'utf8'), inactiveInstructions,
    'inactive AGENTS.md was changed despite AGENTS.override.md');
};
assertInactiveCodexPaths();
const compiledGates = '## Fixture standing order\nVerify the requested behavior before reporting it.\n';
fs.writeFileSync(path.join(home, '.claude', 'gates.generated.md'), compiledGates);
const rulesFile = path.join(codexHome, 'rules', 'permission-wildcarding.rules');
fs.mkdirSync(path.dirname(rulesFile), { recursive: true });
const originalRules = '# Fixture user policy remains owned by the user\n';
fs.writeFileSync(rulesFile, originalRules);

// A transcript the scan can actually learn from, in the real Claude shape.
const projectDir = path.join(home, '.claude', 'projects', 'drive');
fs.mkdirSync(projectDir, { recursive: true });
const lines = [];
for (let i = 0; i < 6; i += 1) {
  lines.push(JSON.stringify({
    type: 'assistant',
    message: { content: [{ type: 'tool_use', id: `call_${i}`, name: 'Bash', input: { command: 'rg --files' } }] },
    cwd: home,
  }));
  lines.push(JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: `call_${i}`, is_error: false, content: 'ok' }] },
    cwd: home,
  }));
}
fs.writeFileSync(path.join(projectDir, 'session.jsonl'), lines.join('\n') + '\n');

// A DISTINCT Codex-only family prevents a passing Claude scan masking a broken
// Codex parser. Use the current custom-tool wrapper and correlate each result.
const codexDir = path.join(codexHome, 'sessions', '2026', '09', '27');
fs.mkdirSync(codexDir, { recursive: true });
const codexLines = [{ type: 'session_meta', payload: { id: 'installed-drive-codex', cwd: home } }];
for (let i = 0; i < 4; i += 1) {
  const call_id = `codex-drive-${i}`;
  codexLines.push({ type: 'response_item', payload: {
    type: 'custom_tool_call', name: 'exec', call_id,
    input: `const result = await tools.exec_command(${JSON.stringify({ cmd: 'git status --short', workdir: home })});`,
  } });
  codexLines.push({ type: 'response_item', payload: {
    type: 'custom_tool_call_output', call_id, output: 'Exit code: 0\n',
  } });
}
fs.writeFileSync(path.join(codexDir, 'rollout-installed-drive.jsonl'),
  codexLines.map((line) => JSON.stringify(line)).join('\n') + '\n');

const commands = new Map();
const shown = [];
const dialogs = [];
const picks = [];
const inputs = [];
// Manual Scan Now still works while automatic scans are disabled. This prevents
// activation's timer from masking a broken explicit scan command.
const config = new Map([['guidance.enabled', false], ['gates.enabled', false], ['autoLearn.enabled', false]]);
const output = [];
function message(kind, m, options, ...choices) {
  shown.push(`${kind === 'error' ? 'ERROR ' : ''}${m}`);
  dialogs.push({ kind, message: String(m), detail: options?.detail || '' });
  // Only the two tested removal modals are accepted. Other prompts remain closed.
  return Promise.resolve(kind === 'warning' &&
    ['Remove shell-style guidance?', 'Remove memory gates?'].includes(m) && choices.includes('Remove')
    ? 'Remove' : undefined);
}

// console.error is a real reporting channel for this extension, so the harness has to
// watch it as well as the vscode stub. Recorded AND still printed, so a failure is
// visible in the transcript rather than only in a counter.
const stderrLines = [];
const realConsoleError = console.error;
console.error = (...args) => {
  stderrLines.push(args.map((a) => (a && a.stack) ? a.stack : String(a)).join(' '));
  realConsoleError.apply(console, args);
};
const vscode = {
  workspace: {
    isTrusted: true,
    workspaceFolders: [{ uri: { fsPath: home } }],
    getConfiguration: () => ({
      get: (k, d) => config.has(k) ? config.get(k) : d,
      update: async (k, v) => { config.set(k, v); },
    }),
    onDidChangeConfiguration: () => ({ dispose() {} }),
    onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
    // Missing from the first version of this harness, and the cost was real: the
    // extension CAUGHT the resulting TypeError and logged "memory lint failed to
    // activate", so "activate() completes" still passed while memoryLint had not run
    // at all. An incomplete stub makes a harness assert less than it claims.
    onDidSaveTextDocument: () => ({ dispose() {} }),
    onDidOpenTextDocument: () => ({ dispose() {} }),
    onDidCloseTextDocument: () => ({ dispose() {} }),
    textDocuments: [],
    fs: { stat: () => Promise.resolve({}) },
    createFileSystemWatcher: () => ({
      onDidChange: () => ({ dispose() {} }),
      onDidCreate: () => ({ dispose() {} }),
      onDidDelete: () => ({ dispose() {} }),
      dispose() {},
    }),
  },
  window: {
    showInformationMessage: (m, o, ...c) => message('info', m, o, ...c),
    showWarningMessage: (m, o, ...c) => message('warning', m, o, ...c),
    showErrorMessage: (m, o, ...c) => message('error', m, o, ...c),
    setStatusBarMessage: () => ({ dispose() {} }),
    onDidChangeActiveTextEditor: () => ({ dispose() {} }),
    onDidChangeVisibleTextEditors: () => ({ dispose() {} }),
    activeTextEditor: undefined,
    visibleTextEditors: [],
    createStatusBarItem: () => ({ show() {}, hide() {}, dispose() {}, text: '' }),
    createOutputChannel: () => ({ appendLine(m) { output.push(String(m)); }, clear() {}, show() {}, dispose() {} }),
    registerWebviewViewProvider: () => ({ dispose() {} }),
    showQuickPick: (items) => {
      const choice = picks.shift();
      return Promise.resolve(items.find((item) => item === choice || item.value === choice));
    },
    showInputBox: () => Promise.resolve(inputs.shift()),
    withProgress: (_o, task) => task({ report() {} }, { onCancellationRequested: () => ({ dispose() {} }) }),
  },
  commands: {
    registerCommand: (id, fn) => { commands.set(id, fn); return { dispose() {} }; },
    executeCommand: () => Promise.resolve(),
  },
  languages: { createDiagnosticCollection: () => ({ set() {}, clear() {}, dispose() {} }) },
  Uri: { file: (p) => ({ fsPath: p }) },
  RelativePattern: class { constructor(b, p) { this.base = b; this.pattern = p; } },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ProgressLocation: { Notification: 15 },
  EventEmitter: class { constructor() { this.event = () => ({ dispose() {} }); } fire() {} dispose() {} },
  ThemeIcon: class {},
  ConfigurationTarget: { Global: 1 },
};

const originalLoad = Module._load;
Module._load = function load(request, parent, isMain) {
  if (request === 'vscode') return vscode;
  if (request === 'os') return { ...os, homedir: () => home };
  return originalLoad.call(this, request, parent, isMain);
};

(async () => {
  const results = [];
  const ok = (name, detail) => { results.push(['PASS', name, detail || '']); };
  const bad = (name, detail) => { results.push(['FAIL', name, detail || '']); };
  const check = async (name, task) => {
    try { const detail = await task(); ok(name, detail); }
    catch (error) { bad(name, error.message); }
  };
  const invoke = async (name) => {
    const id = `permission-wildcarding.${name}`;
    assert.equal(typeof commands.get(id), 'function', `${id} did not register`);
    const start = shown.length;
    await commands.get(id)();
    const errors = shown.slice(start).filter((m) => m.startsWith('ERROR '));
    assert.deepEqual(errors, [], `${id} reported a failure`);
  };
  const state = () => {
    const dir = path.join(home, '.claude', 'wildcarding');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^auto-learn-state.*\.json$/.test(f)) : [];
    assert.equal(files.length, 1, `expected exactly one learner state file under ${dir}`);
    return JSON.parse(fs.readFileSync(path.join(dir, files[0]), 'utf8'));
  };
  const codexCandidate = (value) => {
    const found = Object.values(value.candidates || {}).find((item) => item.prefix.join(' ') === 'git status');
    assert.ok(found, 'Codex-only git status candidate is missing');
    assert.deepEqual(found.sources, ['codex'], 'Codex fixture must not borrow Claude evidence');
    assert.equal(found.counts.success, 4, 'Codex results must be correlated exactly once');
    return found;
  };

  let extension;
  try {
    extension = require(entry);
  } catch (error) {
    bad('the installed extension loads', error.message);
    report(results);
    return;
  }
  ok('the installed extension loads', entry);

  // The stub has to have taken before anything else is believable.
  const probedHome = require(path.join(INSTALLED, 'src', 'permissions.js'));
  assert.ok(probedHome, 'precondition: the packaged src/ is reachable from the installed layout');
  ok('the packaged src/ tree is present and requirable', 'src/permissions.js');

  const subscriptions = [];
  try {
    await extension.activate({ subscriptions });
    ok('activate() completes against the packaged artefact', `${subscriptions.length} subscriptions`);
  } catch (error) {
    bad('activate() completes against the packaged artefact', error.message);
    report(results);
    return;
  }

  const expected = [
    'permission-wildcarding.runNow',
    'permission-wildcarding.autoLearnScan',
    'permission-wildcarding.autoLearnApplySafe',
    'permission-wildcarding.autoLearnUndo',
    'permission-wildcarding.autoLearnWhy',
    'permission-wildcarding.drainLocal',
    'permission-wildcarding.toggleGuidance',
    'permission-wildcarding.toggleGates',
  ];
  const missing = expected.filter((id) => !commands.has(id));
  if (missing.length) bad('the real command handlers registered', `missing: ${missing.join(', ')}`);
  else ok('the real command handlers registered', `${commands.size} commands`);

  // "activate() completes" is satisfied by an activation that swallowed a subsystem
  // failure, which is exactly what happened on the first run of this harness. Assert
  // no subsystem reported itself dead.
  //
  // The FIRST version of this check read only `shown`, the vscode-stub message log, and
  // passed against a real failure — the extension reports that one through console.error,
  // which never touches the stub. A check watching one channel while the thing it guards
  // speaks on another is the same vacuity this whole effort has been hunting, reproduced
  // twice inside the harness written to verify the fixes for it.
  const activationFailures = [...shown, ...stderrLines]
    .filter((m) => /failed to activate|ERROR /.test(m));
  if (activationFailures.length) {
    bad('no subsystem reported a failed activation', activationFailures.join(' | '));
  } else {
    ok('no subsystem reported a failed activation');
  }

  // The retired MAX ids must still be reachable, because an existing keybinding
  // calls them, and they must route to cleanup rather than to an enable path.
  for (const id of ['permission-wildcarding.toggleMax', 'permission-wildcarding.toggleCodexMax']) {
    if (commands.has(id)) ok(`${id} is still reachable after the retirement`);
    else bad(`${id} is still reachable after the retirement`, 'an existing keybinding would error');
  }

  const { commandLaunch } = require(path.join(INSTALLED, 'src', 'exec-resolve.js'));
  const runCodex = (argv) => {
    const launch = commandLaunch('codex', argv);
    const result = spawnSync(launch.file, launch.args, {
      ...launch.options, cwd: home, env: process.env, encoding: 'utf8', windowsHide: true, timeout: 30000,
    });
    assert.ifError(result.error);
    assert.equal(result.status, 0, `Codex CLI failed: ${result.stderr || result.stdout}`);
    return result.stdout.trim();
  };
  const decision = (argv) => JSON.parse(runCodex(['execpolicy', 'check', '--rules', rulesFile, '--', ...argv]));

  await check('the real Codex CLI is available (required)', () => runCodex(['--version']));
  await check('the installed worker learns both Claude and Codex histories', async () => {
    await invoke('autoLearnScan');
    const learned = state();
    const claude = Object.values(learned.candidates).find((item) => item.prefix.join(' ') === 'rg --files');
    assert.ok(claude, 'Claude rg --files candidate is missing');
    assert.deepEqual(claude.sources, ['claude']);
    assert.equal(claude.counts.success, 6, 'Claude baseline must retain six correlated successes');
    const codex = codexCandidate(learned);
    assert.ok(codex.baseAutoSafe, 'Codex read-only candidate must be safe to apply');
    assert.ok(!learned.applied.codex.includes(codex.key), 'recommend-mode scan must leave Codex policy unapplied');
    assert.equal(fs.readFileSync(rulesFile, 'utf8'), originalRules, 'scan changed Codex policy');
    assertInactiveCodexPaths();
    return `${claude.key}: 6 Claude successes; ${codex.key}: 4 Codex-only successes`;
  });
  await check('Codex safe apply, diagnostic, and undo change real policy and learner state', async () => {
    const before = state();
    const candidate = codexCandidate(before);
    const originalSettings = fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8');
    config.set('autoLearn.enabled', true);
    await invoke('autoLearnApplySafe');
    const applied = state();
    assert.ok(applied.applied.codex.includes(candidate.key), 'apply did not mark the Codex candidate applied');
    assertInactiveCodexPaths();
    const written = fs.readFileSync(rulesFile, 'utf8');
    assert.ok(written.startsWith(originalRules), 'apply lost the user-owned policy preamble');
    assert.notEqual(written, originalRules, 'apply did not write Codex rules');
    const allow = decision(['git', 'status', '--short']);
    assert.equal(allow.decision, 'allow', 'written policy does not allow the learned command');
    assert.ok(allow.matchedRules.length > 0, 'allow was not backed by a matching rule');
    const miss = decision(['git', 'reset', '--hard']);
    assert.notEqual(miss.decision, 'allow', 'status rule must not allow a destructive Git command');
    assert.equal(miss.matchedRules.length, 0, 'near-miss unexpectedly matched a rule');
    const transaction = applied.lastApplication;
    assert.ok(transaction?.targets.some((item) => item.kind === 'codex' && path.resolve(item.path) === path.resolve(rulesFile)),
      'Codex undo transaction did not target the selected CODEX_HOME rules file');
    for (const target of transaction.targets) {
      assert.ok(target.path.startsWith(sandbox + path.sep), `policy target escaped the fixture sandbox: ${target.path}`);
      assert.ok(target.backupPath.startsWith(home + path.sep), `backup escaped the fixture home: ${target.backupPath}`);
      assert.ok(fs.existsSync(target.backupPath), `missing undo backup: ${target.backupPath}`);
    }

    const dialogStart = dialogs.length;
    picks.push('codex', 'Bash');
    inputs.push('git status --short');
    await invoke('autoLearnWhy');
    const analysis = dialogs.slice(dialogStart).find((item) => item.message === 'Codex execpolicy analysis');
    assert.ok(analysis, 'Why did this prompt? did not display Codex analysis');
    assert.match(analysis.detail, /decision: allow/, 'diagnostic did not report the actual allow decision');
    assert.ok(analysis.detail.includes('permission-wildcarding.rules'), 'diagnostic omitted the evaluated rule file');
    assert.equal(fs.readFileSync(rulesFile, 'utf8'), written, 'read-only diagnostic changed rules');

    await invoke('autoLearnUndo');
    assert.equal(fs.readFileSync(rulesFile, 'utf8'), originalRules, 'undo did not restore the exact Codex bytes');
    assert.equal(fs.readFileSync(path.join(home, '.claude', 'settings.json'), 'utf8'), originalSettings,
      'undo did not restore the companion Claude policy');
    const undone = state();
    assert.deepEqual(undone.applied, before.applied, 'undo left candidate apply state behind');
    assert.equal(undone.lastApplication, null, 'undo left the transaction active');
    codexCandidate(undone);
    const restored = decision(['git', 'status', '--short']);
    assert.notEqual(restored.decision, 'allow', 'undo left the generated Codex allow effective');
    assert.equal(restored.matchedRules.length, 0);
    assertInactiveCodexPaths();
    return `${rulesFile}: Codex-only evidence -> applied rule + backup -> real CLI allow/near-miss -> diagnostic -> byte-exact undo`;
  });
  await check('guidance and compiled memory gates toggle independently in both instruction files', async () => {
    const guidanceBegin = '<!-- BEGIN permission-wildcarding: shell style (managed) -->';
    const gatesBegin = '<!-- BEGIN permission-wildcarding: memory gates (managed) -->';
    const assertInstructions = (guidanceOn, gatesOn) => {
      assertInactiveCodexPaths();
      for (const file of instructionFiles) {
        const text = fs.readFileSync(file, 'utf8');
        assert.ok(text.startsWith(ownInstructions), `user text was changed in ${file}`);
        assert.equal(text.split(guidanceBegin).length - 1, Number(guidanceOn), `guidance block count in ${file}`);
        assert.equal(text.split(gatesBegin).length - 1, Number(gatesOn), `memory gates block count in ${file}`);
        if (gatesOn) assert.ok(text.includes(compiledGates.trim()), `compiled gate body missing in ${file}`);
        if (!guidanceOn && !gatesOn) assert.equal(text, ownInstructions, `toggle round trip changed ${file}`);
      }
    };
    assertInstructions(false, false);
    await invoke('toggleGuidance');
    assertInstructions(true, false);
    assert.equal(config.get('guidance.enabled'), true);
    await invoke('toggleGates');
    assertInstructions(true, true);
    assert.equal(config.get('gates.enabled'), true);
    await invoke('toggleGuidance');
    assertInstructions(false, true);
    assert.equal(config.get('guidance.enabled'), false);
    await invoke('toggleGates');
    assertInstructions(false, false);
    assert.equal(config.get('gates.enabled'), false);
    return `CLAUDE.md and ${path.basename(codexInstructions)}: on/off, preserved user text, independent blocks and persisted settings`;
  });

  try {
    await extension.deactivate();
    ok('deactivate() resolves', 'no wedged drain');
  } catch (error) {
    bad('deactivate() resolves', error.message);
  }

  // Nothing may have touched the real home.
  const realTouched = shown.filter((m) => m.includes(realHome) && !m.includes(sandbox));
  if (realTouched.length) bad('nothing addressed the real home', realTouched[0]);
  else ok('home lookup and command paths stayed in the fixture', `sandbox ${sandbox}`);

  const commandFailures = [...shown, ...stderrLines].filter((m) => /failed to activate|ERROR /.test(m));
  if (commandFailures.length) bad('no command or subsystem reported an error', commandFailures.join(' | '));
  else ok('no command or subsystem reported an error');

  report(results);
})().catch((error) => {
  console.error('harness threw:', error);
  process.exitCode = 3;
}).finally(() => {
  Module._load = originalLoad;
  console.error = realConsoleError;
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

function report(results) {
  let fail = 0;
  for (const [verdict, name, detail] of results) {
    if (verdict === 'FAIL') fail += 1;
    console.log(`  ${verdict}  ${name}${detail ? `\n        ${detail}` : ''}`);
  }
  console.log(`\ninstalled-artefact drive: ${results.length - fail} pass, ${fail} fail`);
  process.exitCode = fail ? 1 : 0;
}
