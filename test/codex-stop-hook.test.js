'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runCodexStopHook } = require('../src/codex-stop-hook');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { scanHistoryFiles } = require('../src/history-adapters');
const { createPolicyLock, POLICY_LOCK_CODE } = require('../src/policy-lock');

// Codex 0.161.0 parses Stop output with `deny_unknown_fields`; these are the
// only keys it accepts (codex-rs/hooks/src/events/stop.rs, read 2026-10-13).
// Any other key fails the run as invalid JSON output, so every output this
// hook prints must be a subset -- in practice `{}` or `{ systemMessage }`.
const CODEX_STOP_KEYS = new Set(['continue', 'stopReason', 'suppressOutput', 'systemMessage', 'decision', 'reason']);
function assertWarning(output, label) {
  assert.ok(output && typeof output === 'object' && !Array.isArray(output), label);
  for (const key of Object.keys(output)) assert.ok(CODEX_STOP_KEYS.has(key), `${label}: ${key} would fail the Codex run`);
  assert.deepEqual(Object.keys(output), ['systemMessage'], label);
  assert.equal(typeof output.systemMessage, 'string');
  return output.systemMessage;
}
// No path reaches the Codex UI: not a drive, not a separator, not the fixture's
// temp folder, not the account name a profile path carries.
function assertPathFree(message, box) {
  assert.doesNotMatch(message, /[A-Za-z]:[\\/]|[\\/]/, 'no path separator reaches the Codex UI');
  for (const part of [path.basename(box.root), 'rollout-stop', os.userInfo().username]) {
    assert.equal(message.toLowerCase().includes(part.toLowerCase()), false, `the message names no ${part}`);
  }
}

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-stop-hook-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = path.join(root, 'home');
  const codexHome = path.join(root, 'profile');
  const workspace = path.join(root, 'workspace');
  for (const dir of [home, codexHome, workspace, path.join(codexHome, 'sessions'), path.join(home, '.claude', 'projects')]) fs.mkdirSync(dir, { recursive: true });
  const rows = [{ type: 'session_meta', payload: { id: 'stop-hook-fixture', cwd: workspace } }];
  function observation(command, exit_code, id) {
    rows.push({ type: 'response_item', payload: { type: 'function_call', name: 'shell_command', call_id: id,
      arguments: JSON.stringify({ command, workdir: workspace }) } });
    rows.push({ type: 'response_item', payload: { type: 'function_call_output', call_id: id,
      output: JSON.stringify({ exit_code, output: 'fixture output' }) } });
  }
  observation('git status --short', 0, 'ok');
  observation('git log --oneline', 7, 'failed');
  fs.writeFileSync(path.join(codexHome, 'sessions', 'rollout-stop.jsonl'), rows.map(JSON.stringify).join('\n') + '\n');
  fs.writeFileSync(path.join(home, '.claude', 'projects', 'foreign.jsonl'), [
    { type: 'assistant', cwd: workspace, message: { content: [{ type: 'tool_use', id: 'claude-only', name: 'Bash', input: { command: 'whoami' } }] } },
    { type: 'user', cwd: workspace, message: { content: [{ type: 'tool_result', tool_use_id: 'claude-only', content: 'fixture', is_error: false }] } },
  ].map(JSON.stringify).join('\n') + '\n');
  const settings = path.join(home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{"permissions":{"allow":["Bash(existing *)"]},"owner":"preserve"}\r\n');
  return { root, home, codexHome, workspace, settings,
    input: { hook_event_name: 'Stop', cwd: workspace, tool_response: 'THIS IS NOT SUCCESS EVIDENCE' } };
}

test('Stop hook uses completed Codex history, retains failed outcomes and deduplicates repeated turns', (t) => {
  const box = fixture(t);
  const manager = createAutoLearnManager({ home: box.home, codexHome: box.codexHome, workspaceRoot: box.workspace });
  manager.setMode('observe', 5);
  const beforeClaude = fs.readFileSync(box.settings);
  const first = runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome });
  assert.equal(first.ok, true);
  assert.equal(first.scan.newObservations, 2, 'WITNESS Codex hook does not import Claude-only history');
  const state = manager.status();
  assert.equal(state.mode, 'observe', 'WITNESS Stop preserves the existing learner mode');
  assert.equal(state.threshold, 5);
  const candidates = manager.listCandidates();
  assert.equal(candidates.length, 2, 'WITNESS Codex hook does not import Claude-only history');
  assert.equal(candidates.find((candidate) => candidate.prefix[1] === 'status').counts.success, 1);
  const failed = candidates.find((candidate) => candidate.prefix[1] === 'log');
  assert.equal(failed.counts.success, 0, 'WITNESS raw hook output never turns a failed transcript into success');
  assert.equal(failed.counts.failed, 1);
  assert.equal(runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome }).scan.newObservations, 0,
    'WITNESS repeated Stop reuses existing observation deduplication');
  assert.deepEqual(fs.readFileSync(box.settings), beforeClaude);
});

test('Stop auto-safe mode writes only Codex policy and preserves Claude settings exactly', (t) => {
  const box = fixture(t);
  const manager = createAutoLearnManager({ home: box.home, codexHome: box.codexHome, workspaceRoot: box.workspace });
  manager.setMode('auto-safe', 1);
  const beforeClaude = fs.readFileSync(box.settings);
  let usedSettings;
  const result = runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome, createManager(settings) {
    usedSettings = settings;
    return createAutoLearnManager({ ...settings, codexValidator: () => ({ valid: true, decision: 'allow' }),
      codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }) });
  } });
  assert.equal(result.ok, true);
  assert.equal(Object.hasOwn(usedSettings, 'mode'), false, 'WITNESS adapter never forces a learner mode');
  assert.equal(manager.status().mode, 'auto-safe');
  assert.ok(fs.readFileSync(manager.paths.codexRules, 'utf8').includes('status'), 'WITNESS Codex automatic policy writing remains active');
  assert.deepEqual(fs.readFileSync(box.settings), beforeClaude, 'WITNESS Codex Stop never becomes a Claude policy writer');
  assert.equal(fs.existsSync(manager.paths.claudeClaims), false);
});

test('Stop adapter validates event and directory before constructing a manager and exposes scan failures', (t) => {
  const box = fixture(t);
  let calls = 0;
  const createManager = () => { calls++; return { scan: () => ({ errors: 0, partial: 0 }) }; };
  for (const input of [null, [], {}, { hook_event_name: 'PostToolUse', cwd: box.workspace },
    { hook_event_name: 'Stop', cwd: 'relative' }, { hook_event_name: 'Stop', cwd: box.settings }]) {
    assert.throws(() => runCodexStopHook(input, { createManager }), /Stop|directory/,
      'WITNESS only a valid Stop event with an absolute directory can scan');
  }
  assert.equal(calls, 0);
  assert.throws(() => runCodexStopHook(box.input, { createManager: () => ({ scan() { throw new Error('locked fixture'); } }) }), /locked fixture/,
    'WITNESS an exception nothing anticipated still escapes, so the CLI can exit 1 for a broken hook');
  const busy = runCodexStopHook(box.input, { createManager: () => ({ scan() {
    throw Object.assign(new Error('Auto Learn is mid-scan'), { code: POLICY_LOCK_CODE });
  } }) });
  assert.equal(busy.ok, false, 'a held lock is not a scan');
  assert.match(assertWarning(busy.output, 'held lock'), /^AI Acolyte: Codex learning could not read history this turn: another AI Acolyte scan was running\. Nothing was lost/,
    'WITNESS the expected busy condition is a warning, not an escaping exception');
  const incomplete = runCodexStopHook(box.input, { createManager: () => ({ scan: () => ({ errors: 1, partial: 0 }) }) });
  assert.equal(incomplete.ok, false, 'WITNESS incomplete history is not reported as a successful hook');
  assert.match(incomplete.error, /incomplete/);
  assert.equal(assertWarning(incomplete.output, 'counts only'),
    'AI Acolyte: Codex learning could not read 1 history file or folder.',
    'a manager that never called the scanner still yields a reason, from its counts');
  let received;
  runCodexStopHook(box.input, { createManager: (settings) => { received = settings; return { scan: () => ({}) }; } });
  assert.equal(Object.hasOwn(received, 'home'), false);
  assert.equal(Object.hasOwn(received, 'codexHome'), false, 'ambient resolver stays authoritative unless explicitly overridden');
});

// A deferred file is catch-up, not a failure. Before 2026-10-13 `partial > 0`
// failed the hook, so every Stop while a transcript over 64 MiB was still being
// read showed Codex "hook exited with code 1" -- three Stops for the 170 MB
// archived rollout on the development box -- over scans that lost nothing. The
// counts below are the manager's own fields; only the ones that mean evidence
// was LOST may fail the run.
test('Stop treats a budget deferral as progress and still fails on lost evidence', (t) => {
  const box = fixture(t);
  const run = (scan) => runCodexStopHook(box.input, { createManager: () => ({ scan: () => scan }) });
  const deferred = run({ errors: 0, partial: 2, deferredBytes: 100 * 1048576, unreadable: 0 });
  assert.equal(deferred.ok, true, 'WITNESS a per-scan budget deferral alone is progress, not a failed hook');
  assert.deepEqual(deferred.output, {}, 'another file catching up is silent, as it is in the extension');
  assert.equal(run({ errors: 0, partial: 0 }).ok, true, 'control: a clean scan passes');
  const lost = run({ errors: 0, partial: 1, unreadable: 1 });
  assert.equal(lost.ok, false, 'WITNESS a stepped-over stretch is evidence no later scan can read');
  assert.match(lost.error, /1 unreadable/);
  assert.match(assertWarning(lost.output, 'unreadable'), /could not read 1 stretch of transcript with no line break inside 256 MiB, skipped for good\.$/);
  const errored = run({ errors: 2, partial: 1, unreadable: 0 });
  assert.equal(errored.ok, false, 'a read error still fails beside a deferral');
  assert.match(assertWarning(errored.output, 'errors'), /could not read 2 history files or folders\.$/);
  const blind = run({ errors: 0, partial: 0, blindScan: true });
  assert.equal(blind.ok, false);
  assert.match(blind.error, /nothing could be listed/);
  assert.match(assertWarning(blind.output, 'blind'), /could not read any Codex history: no transcript could be listed, so this scan learned nothing/);
});

// Until 2026-10-13 each case below exited 1, and Codex 0.161.0 reads stderr
// only for exit 2, so the reason never reached the Codex user: the run showed
// "hook exited with code 1" and nothing else. Now each one completes with a
// systemMessage naming what could not be read. The scanner seam is the real
// scanner plus one injected entry, so the manager's own counting decides
// that the scan lost evidence; nothing here hands the hook a verdict.
function injecting(extra) {
  return (request) => {
    const result = scanHistoryFiles(request);
    return { ...result, files: [...result.files, ...extra(request)] };
  };
}

// Node's own messages carry the full path ("EACCES: permission denied, open
// 'C:\\...'"), which is exactly what must not reach the Codex UI.
const rolloutOf = (box) => path.join(box.codexHome, 'sessions', 'rollout-stop.jsonl');
const LOST = [
  ['a transcript read error', (box) => ({ path: rolloutOf(box), source: 'codex', mode: 'error', size: 10, bytesRead: 0,
    error: `EACCES: permission denied, open '${rolloutOf(box)}'` }), /could not read 1 transcript \(EACCES\); the next scan retries them\.$/],
  ['a folder that could not be listed', (box) => ({ path: path.join(box.codexHome, 'archived_sessions'), source: 'codex', mode: 'error',
    scope: 'root', error: `EPERM: operation not permitted, scandir '${path.join(box.codexHome, 'archived_sessions')}'` }),
  /could not read 1 history folder \(archived_sessions: EPERM\)\.$/],
  ['a stepped-over stretch', (box) => ({ path: rolloutOf(box), source: 'codex', mode: 'unreadable', size: 300 * 1048576,
    consumedEnd: 300 * 1048576 }), /could not read 1 stretch of transcript with no line break inside 256 MiB, skipped for good\.$/],
];

test('Stop names what it could not read, as a warning with no path in it', (t) => {
  for (const [label, entry, reason] of LOST) {
    const box = fixture(t);
    const result = runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome,
      historyScanner: injecting(() => [entry(box)]) });
    assert.equal(result.ok, false, `${label}: the scan lost evidence`);
    const message = assertWarning(result.output, label);
    assert.match(message, /^AI Acolyte: Codex learning could not read /);
    assert.match(message, reason, `WITNESS ${label} reaches the Codex user with its reason`);
    assertPathFree(message, box);
  }
  const box = fixture(t);
  // Real, nothing injected: a profile whose history folder disappeared after
  // cursors were saved is a blind scan with zero errors (ENOENT is not one).
  assert.deepEqual(runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome }).output, {}, 'control: the first scan is clean');
  fs.rmSync(path.join(box.codexHome, 'sessions'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const blind = runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome });
  assert.equal(blind.scan.blindScan, true);
  assert.equal(blind.scan.errors, 0);
  const message = assertWarning(blind.output, 'blind scan');
  assert.match(message, /^AI Acolyte: Codex learning could not read any Codex history: no transcript could be listed, so this scan learned nothing and kept its saved positions\.$/);
  assertPathFree(message, box);
});

test('Stop says both when it lost evidence and this turn\'s own rollout was deferred', (t) => {
  const box = fixture(t);
  const scanner = injecting(() => [{ path: path.join(box.codexHome, 'sessions', '2026'), source: 'codex', mode: 'error',
    scope: 'root', error: 'EBUSY: resource busy or locked' }]);
  const result = runCodexStopHook({ ...box.input, transcript_path: rolloutOf(box) }, { home: box.home, codexHome: box.codexHome,
    historyScanner: (request) => scanner({ ...request, ingestBytes: 200 }) });
  assert.equal(result.ok, false);
  assert.ok(result.deferred, 'control: this turn\'s rollout was deferred too');
  const message = assertWarning(result.output, 'loss and deferral');
  assert.match(message, /^AI Acolyte: Codex learning could not read 1 history folder \(2026: EBUSY\)\. This session's transcript is larger than one scan reads, .* MB left\)\. The next scan continues where this one stopped\.$/,
    'WITNESS one systemMessage carries both, loss first');
  assert.doesNotMatch(message, /nothing failed/, 'a run that lost evidence never says nothing failed');
  assertPathFree(message, box);
});

test('Stop hook holds the Auto Learn lock contention as a warning, and a real lock still blocks the scan', (t) => {
  const box = fixture(t);
  const manager = createAutoLearnManager({ home: box.home, codexHome: box.codexHome, workspaceRoot: box.workspace });
  const result = createPolicyLock({ lockPath: manager.paths.lock }).locked(() =>
    runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome }));
  assert.equal(result.ok, false);
  assert.equal(result.scan, null, 'WITNESS nothing was scanned while another scan held the lock');
  assert.match(assertWarning(result.output, 'busy'), /another AI Acolyte scan was running\. Nothing was lost; the next scan learns this turn\.$/);
  assert.equal(manager.listCandidates().length, 0, 'control: the held lock really kept the scan out');
  assert.equal(runCodexStopHook(box.input, { home: box.home, codexHome: box.codexHome }).scan.newObservations, 2,
    'WITNESS nothing was lost: the next Stop learns the turn the busy one skipped');
});

// Codex's own payload names the turn's rollout (`transcript_path`), so whether
// THIS turn's commands are in the deferred tail is a lookup. The budget is
// shrunk through the same scanner the manager uses, instead of writing a
// 64 MiB fixture.
function smallBudget(ingestBytes) {
  return (request) => scanHistoryFiles({ ...request, ingestBytes });
}

test('Stop says, without failing, when the current turn\'s own rollout was deferred', (t) => {
  const box = fixture(t);
  const rollout = path.join(box.codexHome, 'sessions', 'rollout-stop.jsonl');
  const input = { ...box.input, transcript_path: rollout };
  const options = { home: box.home, codexHome: box.codexHome, historyScanner: smallBudget(200) };
  const first = runCodexStopHook(input, options);
  assert.equal(first.ok, true, 'WITNESS the current transcript catching up is not a hook failure');
  assert.ok(first.scan.partial >= 1);
  assert.ok(first.deferred && first.deferred.remainingBytes > 0);
  assert.deepEqual(Object.keys(first.output), ['systemMessage'],
    'WITNESS only a key Codex 0.161.0 accepts (deny_unknown_fields) carries the note');
  assert.match(first.output.systemMessage, /not learned yet .* MB left\)\. The next scan continues/);
  assert.doesNotMatch(first.output.systemMessage, /rollout-stop|[A-Za-z]:\\|\//, 'no path reaches the Codex UI');
  if (process.platform === 'win32') {
    // Codex writes both `\\?\C:\...` and plain spellings of one rollout path
    // (seen in one state table 2026-10-13), and upper/lower case name one file.
    // A fresh home, because this fixture finishes on its second scan.
    const other = fixture(t);
    const spelled = path.join(other.codexHome, 'sessions', 'rollout-stop.jsonl');
    assert.ok(runCodexStopHook({ ...other.input, transcript_path: '\\\\?\\' + spelled.toUpperCase() },
      { home: other.home, codexHome: other.codexHome, historyScanner: smallBudget(200) }).deferred,
    'WITNESS an extended-length, differently cased spelling is the same rollout');
  }
  let last = first;
  for (let n = 0; n < 40 && last.scan.partial > 0; n++) last = runCodexStopHook(input, options);
  assert.equal(last.scan.partial, 0, 'the deferral converges');
  assert.equal(last.deferred, null);
  assert.deepEqual(last.output, {}, 'control: once caught up the output is neutral again');
  const manager = createAutoLearnManager({ home: box.home, codexHome: box.codexHome, workspaceRoot: box.workspace });
  assert.equal(manager.listCandidates().length, 2, 'every call in the deferred tail was learned by the later Stops');
});

test('Stop names only its own rollout\'s deferral, not another transcript catching up', (t) => {
  const box = fixture(t);
  const big = path.join(box.codexHome, 'sessions', 'rollout-stop.jsonl');
  const current = path.join(box.codexHome, 'sessions', 'rollout-current.jsonl');
  fs.writeFileSync(current, JSON.stringify({ type: 'session_meta', payload: { id: 'cur', cwd: box.workspace } }) + '\n');
  assert.ok(fs.statSync(current).size < 200 && fs.statSync(big).size > 200, 'fixture: only the other file exceeds the budget');
  const result = runCodexStopHook({ ...box.input, transcript_path: current },
    { home: box.home, codexHome: box.codexHome, historyScanner: smallBudget(200) });
  assert.equal(result.ok, true);
  assert.ok(result.scan.partial >= 1, 'control: a deferral did happen this scan');
  assert.equal(result.deferred, null, 'WITNESS another file\'s deferral is not this turn\'s');
  assert.deepEqual(result.output, {});
  for (const transcript of [null, 'relative.jsonl', undefined]) {
    assert.deepEqual(runCodexStopHook({ ...box.input, transcript_path: transcript },
      { home: box.home, codexHome: box.codexHome, historyScanner: smallBudget(200) }).output, {},
      'a missing or relative transcript_path is "not deferred", never an error');
  }
});

test('standalone Stop callback emits neutral JSON and rejects malformed or oversized input visibly', (t) => {
  const box = fixture(t);
  const executable = path.resolve(__dirname, '..', 'src', 'codex-stop-hook.js');
  const options = { cwd: box.workspace, env: { ...process.env, HOME: box.home, USERPROFILE: box.home, CODEX_HOME: box.codexHome },
    encoding: 'utf8', windowsHide: true, timeout: 30000 };
  const good = spawnSync(process.execPath, [executable], { ...options, input: JSON.stringify(box.input) });
  assert.equal(good.status, 0, good.stderr);
  assert.deepEqual(JSON.parse(good.stdout), {}, 'WITNESS callback requests no block, continuation or extra context');
  for (const input of ['{bad', 'x'.repeat(1024 * 1024 + 1)]) {
    const bad = spawnSync(process.execPath, [executable], { ...options, input });
    assert.equal(bad.status, 1, 'WITNESS callback failure is visible as nonzero exit');
    assert.match(bad.stderr, /AI Acolyte Codex Stop hook:/);
    assert.equal(bad.stdout, '');
  }
});

// The process half: what reaches Codex's stdout is the output the run computed,
// not a fixed `{}`. The preload shrinks the budget on the module the hook
// resolves at call time, so the real CLI path is the one exercised.
test('standalone Stop callback prints its own deferral as a systemMessage and exits 0', (t) => {
  const box = fixture(t);
  const executable = path.resolve(__dirname, '..', 'src', 'codex-stop-hook.js');
  const preload = path.join(box.root, 'small-budget.js');
  fs.writeFileSync(preload, `const adapters = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'history-adapters.js'))});\n` +
    'const real = adapters.scanHistoryFiles;\nadapters.scanHistoryFiles = (options) => real({ ...options, ingestBytes: 200 });\n');
  const input = JSON.stringify({ ...box.input, transcript_path: path.join(box.codexHome, 'sessions', 'rollout-stop.jsonl') });
  const options = { cwd: box.workspace, env: { ...process.env, HOME: box.home, USERPROFILE: box.home, CODEX_HOME: box.codexHome },
    encoding: 'utf8', windowsHide: true, timeout: 30000, input };
  const deferred = spawnSync(process.execPath, ['--require', preload, executable], options);
  assert.equal(deferred.status, 0, 'WITNESS a deferred current rollout is not a failed hook: ' + deferred.stderr);
  const printed = JSON.parse(deferred.stdout);
  assert.deepEqual(Object.keys(printed), ['systemMessage'], 'WITNESS the callback prints the note the run computed');
  assert.match(printed.systemMessage, /not learned yet/);
  // Control on the same home: drained without the preload, the default budget
  // finishes the file and the callback is neutral again.
  const drained = spawnSync(process.execPath, [executable], options);
  assert.equal(drained.status, 0, drained.stderr);
  assert.deepEqual(JSON.parse(drained.stdout), {});
});

// The exit table at the top of src/codex-stop-hook.js, as Codex sees it: an
// exit code and stdout. A scan that lost evidence, and a held lock, complete
// with exit 0 and the reason as a systemMessage; until 2026-10-13 both exited
// 1 and the reason went to stderr, which Codex 0.161.0 reads only for exit 2.
// A defect escaping the hook still exits 1, so a broken hook stays a "Failed"
// run rather than one more warning.
const EXECUTABLE = path.resolve(__dirname, '..', 'src', 'codex-stop-hook.js');
const cliOptions = (box, input = box.input) => ({ cwd: box.workspace, encoding: 'utf8', windowsHide: true, timeout: 30000,
  env: { ...process.env, HOME: box.home, USERPROFILE: box.home, CODEX_HOME: box.codexHome }, input: JSON.stringify(input) });
function scannerPreload(box, name, body) {
  const file = path.join(box.root, name);
  fs.writeFileSync(file, `const adapters = require(${JSON.stringify(path.resolve(__dirname, '..', 'src', 'history-adapters.js'))});\n` +
    `const real = adapters.scanHistoryFiles;\n${body}\n`);
  return file;
}

test('standalone Stop callback exits 0 with the reason when it could not read something', (t) => {
  const box = fixture(t);
  const options = cliOptions(box);
  const preload = scannerPreload(box, 'eacces.js', 'adapters.scanHistoryFiles = (options) => { const result = real(options);\n' +
    '  const file = result.files[0].path;\n' +
    '  return { ...result, files: [...result.files, { path: file, source: "codex", mode: "error", error: `EACCES: permission denied, open \'${file}\'` }] }; };');
  const lost = spawnSync(process.execPath, ['--require', preload, EXECUTABLE], options);
  assert.equal(lost.status, 0, 'WITNESS a scan that lost evidence is a completed run with a reason, not "hook exited with code 1": ' + lost.stderr);
  assert.equal(lost.stderr, '');
  const message = assertWarning(JSON.parse(lost.stdout), 'CLI lost evidence');
  assert.match(message, /^AI Acolyte: Codex learning could not read 1 transcript \(EACCES\); the next scan retries them\.$/);
  assertPathFree(message, box);
  // This process holds the Auto Learn lock while the hook runs.
  const manager = createAutoLearnManager({ home: box.home, codexHome: box.codexHome, workspaceRoot: box.workspace });
  const busy = createPolicyLock({ lockPath: manager.paths.lock }).locked(() => spawnSync(process.execPath, [EXECUTABLE], options));
  assert.equal(busy.status, 0, 'WITNESS another scan holding the lock is a warning, not a failed hook: ' + busy.stderr);
  assert.match(assertWarning(JSON.parse(busy.stdout), 'CLI busy'), /another AI Acolyte scan was running\. Nothing was lost/);
  // Real, nothing injected: cursors are saved, then the history folder goes.
  fs.rmSync(path.join(box.codexHome, 'sessions'), { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  const blind = spawnSync(process.execPath, [EXECUTABLE], options);
  assert.equal(blind.status, 0, blind.stderr);
  assert.match(assertWarning(JSON.parse(blind.stdout), 'CLI blind scan'), /could not read any Codex history: no transcript could be listed/);
});

test('standalone Stop callback still exits 1 when the hook itself breaks', (t) => {
  const box = fixture(t);
  const preload = scannerPreload(box, 'defect.js', 'adapters.scanHistoryFiles = () => { throw new TypeError("injected scanner defect"); };');
  const broken = spawnSync(process.execPath, ['--require', preload, EXECUTABLE], cliOptions(box));
  assert.equal(broken.status, 1, 'WITNESS an exception nothing anticipated stays distinguishable as a failed run');
  assert.match(broken.stderr, /^AI Acolyte Codex Stop hook: injected scanner defect$/m);
  assert.equal(broken.stdout, '', 'no output object for Codex to parse on a failed run');
});
