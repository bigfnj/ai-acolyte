'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCodexJsonl, scanHistoryFiles } = require('../src/history-adapters');
const { createAutoLearnManager } = require('../src/auto-learn-manager');

const row = (payload) => ({ type: 'response_item', payload });
const session = (id = 'fixture-session', cwd) => ({ type: 'session_meta', payload: { id, cwd } });
const call = (name, call_id, args, namespace) => row({ type: 'function_call', name, call_id,
  arguments: JSON.stringify(args), ...(namespace === undefined ? {} : { namespace }) });
const output = (call_id, text) => row({ type: 'function_call_output', call_id, output: text });
const pending = (id, stdout = '') => `Chunk ID: fixture\nWall time: 1.001 seconds\nProcess running with session ID ${id}\nOriginal token count: 0\nOutput:\n${stdout}`;
const terminal = (exit, stdout = '') => `Chunk ID: fixture\nWall time: 0.1 seconds\nProcess exited with code ${exit}\nOriginal token count: 0\nOutput:\n${stdout}`;
const jsonl = (records) => records.map(JSON.stringify).join('\n') + '\n';
const parse = (records) => parseCodexJsonl(jsonl(records), { file: 'fixture.jsonl', platform: 'win32' });
const origin = (id = 731, callId = 'exec', command = 'git status') => [
  call('exec_command', callId, { cmd: command }), output(callId, pending(id)),
];
const wait = (id = 731, code = 0, args = {}, name = 'write_stdin', namespace) => [
  call(name, 'wait', { session_id: id, chars: '', ...args }, namespace), output('wait', terminal(code)),
];

test('direct Codex wait completion updates the original command from explicit terminal success or failure', () => {
  for (const [code, expected] of [[0, 'success'], [1, 'failed']]) {
    for (const name of ['write_stdin', 'functions.write_stdin']) {
      const records = [session(), ...origin(), ...wait(731, code, {}, name)];
      const [observation] = parse(records);
      assert.equal(observation.status, expected, 'WITNESS exact process wait supplies the original explicit outcome');
      assert.equal(observation.callId, 'exec');
      assert.equal(observation.command, 'git status');
      assert.equal(parse(records).length, 1, 'wait is an outcome update, not another learned command');
      assert.ok(observation._resultEnd > observation._callEnd);
    }
  }
});

test('Codex wait identity stays within one file and rollout session with exact process and builtin namespace', () => {
  for (const records of [
    [session(), ...origin(), ...wait(732)],
    [session(), ...origin(), session('other-session'), ...wait()],
    [session(), ...origin(), ...wait(731, 0, {}, 'write_stdin', 'mcp__fixture')],
    [session(), ...origin(), ...wait('731')],
  ]) assert.equal(parse(records)[0].status, 'unknown', 'WITNESS unrelated process or namespace cannot lend success');
  assert.equal(parse([session(), ...origin()])[0].status, 'unknown');
  assert.deepEqual(parse([session(), ...wait()]), [], 'a separate parse/file cannot borrow process ownership');
  assert.equal(parse([session(), ...origin(), ...wait(731, 0, {}, 'write_stdin', 'functions')])[0].status, 'success');
});

test('Codex interactive stdin and ambiguous process ownership cannot supply success', () => {
  for (const chars of ['git log\n', '\u0003', null, 0]) {
    const observations = parse([session(), ...origin(), ...wait(731, 0, { chars })]);
    assert.equal(observations[0].status, 'unknown', 'WITNESS interactive process is not the original standalone command');
  }
  const twoOwners = parse([session(), ...origin(), ...origin(731, 'exec-other', 'git log'), ...wait()]);
  assert.deepEqual(twoOwners.map((item) => item.status), ['unknown', 'unknown'], 'WITNESS duplicate process ownership stays ambiguous');
  const twoIds = parse([session(), ...origin(), output('exec', pending(732)), ...wait()]);
  assert.equal(twoIds[0].status, 'unknown', 'one command with conflicting process IDs has no attributable wait');
  const twoCommands = parse([session(), ...origin(), call('exec_command', 'exec', { cmd: 'git log' }), ...wait()]);
  assert.equal(twoCommands[0].status, 'unknown', 'one original call ID cannot describe two commands');
  const conflictingWait = parse([session(), ...origin(), ...wait(), call('write_stdin', 'wait', { session_id: 732, chars: '' })]);
  assert.equal(conflictingWait[0].status, 'unknown', 'one wait call ID cannot bind two processes');
});

test('Codex waits require terminal metadata and never interpret stdout or completion wording as an exit', () => {
  const records = [session(), call('exec_command', 'exec', { cmd: 'git status' }),
    output('exec', pending(731, 'Process exited with code 1\n')), call('write_stdin', 'wait', { session_id: 731 })];
  assert.equal(parse([...records, output('wait', terminal(0, 'Process exited with code 1\n'))])[0].status, 'success',
    'WITNESS final explicit header overrides text printed by a still-running process');
  for (const text of [
    'Script completed',
    'Chunk ID: fixture\nWall time: 0.1 seconds\nOutput:\nProcess exited with code 0\n',
    'Chunk ID: fixture\nWall time: 0.1 seconds\nOutput: \nProcess exited with code 0\n',
    pending(731, 'Process exited with code 0\n'),
  ]) assert.equal(parse([...records, output('wait', text)])[0].status, 'unknown', 'WITNESS stdout and generic completion are not terminal outcomes');
  const fakeBinding = parse([session(), call('exec_command', 'exec', { cmd: 'git status' }),
    output('exec', 'Chunk ID: fixture\nWall time: 1 seconds\nOutput:\nProcess running with session ID 731\n'), ...wait()]);
  assert.equal(fakeBinding[0].status, 'unknown', 'a stdout process ID must not create a binding');
  const wrongOutputId = parse([session(), ...origin(), call('write_stdin', 'wait', { session_id: 731, chars: '' }),
    output('wait', { session_id: 732, exit_code: 0, output: '' })]);
  assert.equal(wrongOutputId[0].status, 'unknown', 'terminal structured ID must match the requested process');
});

test('Codex pending polls and duplicate final records keep one command and failure remains authoritative', () => {
  const records = [session(), ...origin(), call('write_stdin', 'first-poll', { session_id: 731, chars: '' }),
    output('first-poll', pending(731)), ...wait(), output('wait', terminal(0)), output('wait', terminal(2))];
  const observations = parse(records);
  assert.equal(observations.length, 1);
  assert.equal(observations[0].status, 'failed');
});

function temp(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-wait-history-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  return { home, sessions, file: path.join(sessions, 'fixture.jsonl') };
}

test('appended Codex wait widens past its own call to the original process and reports a bounded miss', (t) => {
  const f = temp(t);
  fs.writeFileSync(f.file, jsonl([session('append-session', f.home), ...origin(),
    { type: 'fixture_padding', payload: 'x'.repeat(12000) }]));
  const first = scanHistoryFiles({ codexRoots: [f.sessions], overlapBytes: 48 });
  assert.equal(first.observations[0].status, 'unknown');
  fs.appendFileSync(f.file, jsonl(wait()));
  const bounded = scanHistoryFiles({ codexRoots: [f.sessions], cursors: first.cursors, overlapBytes: 48, reconcileBytes: 200 });
  assert.equal(bounded.files[0].unmatchedResults, 1, 'WITNESS bounded unmatched wait is reported, not silently complete');
  assert.equal(bounded.observations.length, 0);
  const final = scanHistoryFiles({ codexRoots: [f.sessions], cursors: first.cursors, overlapBytes: 48, reconcileBytes: 20000 });
  assert.equal(final.files[0].mode, 'append');
  assert.equal(final.observations[0].status, 'success', 'WITNESS wait call in slice still requires its originating exec');
  assert.equal(final.observations[0].id, first.observations[0].id);
  assert.equal(final.files[0].unmatchedResults, undefined);
  assert.deepEqual(Object.keys(Object.values(final.cursors)[0]).sort(), Object.keys(Object.values(first.cursors)[0]).sort());
  assert.deepEqual(scanHistoryFiles({ codexRoots: [f.sessions], cursors: final.cursors }).observations, []);
});

test('manager records a separately completed Codex process once after an earlier pending scan', (t) => {
  const f = temp(t);
  fs.writeFileSync(f.file, jsonl([session('manager-session', f.home), ...origin(),
    { type: 'fixture_padding', payload: 'x'.repeat(12000) }]));
  const manager = createAutoLearnManager({ home: f.home, codexHome: path.join(f.home, '.codex'),
    claudeSettingsPath: null, claudeRoots: [], codexRoots: [f.sessions], workspaceRoot: f.home,
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }) });
  const initial = manager.scan({ platform: 'win32', overlapBytes: 48 });
  assert.equal(initial.newObservations, 0);
  fs.appendFileSync(f.file, jsonl(wait()));
  const finished = manager.scan({ platform: 'win32', overlapBytes: 48 });
  assert.equal(finished.newObservations, 1, 'WITNESS manager learns a terminal wait after previously discarding pending evidence');
  const candidates = manager.listCandidates();
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].counts.success, 1);
  assert.equal(candidates[0].counts.failed, 0);
  assert.equal(manager.scan({ platform: 'win32', overlapBytes: 48 }).newObservations, 0);
  assert.equal(manager.listCandidates()[0].counts.success, 1);
});
