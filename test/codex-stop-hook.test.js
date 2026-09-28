'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { spawnSync } = require('node:child_process');
const { runCodexStopHook } = require('../src/codex-stop-hook');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

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
