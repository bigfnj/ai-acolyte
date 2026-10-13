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
  assert.throws(() => runCodexStopHook(box.input, { createManager: () => ({ scan() { throw new Error('locked fixture'); } }) }), /locked fixture/);
  const incomplete = runCodexStopHook(box.input, { createManager: () => ({ scan: () => ({ errors: 1, partial: 0 }) }) });
  assert.equal(incomplete.ok, false, 'WITNESS incomplete history is not reported as a successful hook');
  assert.match(incomplete.error, /incomplete/);
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
  assert.equal(run({ errors: 2, partial: 1, unreadable: 0 }).ok, false, 'a read error still fails beside a deferral');
  const blind = run({ errors: 0, partial: 0, blindScan: true });
  assert.equal(blind.ok, false);
  assert.match(blind.error, /nothing could be listed/);
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
