'use strict';

// A CALL IS GROUPED WITH ITS RESULT INSIDE ITS OWN SESSION (2026-10-13).
//
// parseCodexJsonl joins each call to its result through `callGroups` and `results`,
// and both were keyed by the call id alone. Everything else the parser joins was
// already scoped by session: observation identity (createObservation's
// identityParts), unified-exec process ids (applyCodexProcessResults), code-mode
// cell IDs (codeModeJoin), MCP identity. So two sessions in one rollout file that
// reused a call id collapsed into ONE group: two observations in a group withhold
// success (applyCodexGroupResult), and either session's failure was applied to
// both. Found while writing the code-mode session-scope test (d934419), whose
// second session had to rename its call ids to get past it.
//
// Real call ids are unique, and a rollout Codex writes holds one session (a
// fork's head names two, and everything after it belongs to the second, the
// 9abc330 rule), so this is defence in depth -- but the MCP fixture's five real
// sessions already reuse one call id between them, as the scripted responder
// always issues `call_fixture`, so concatenated real rollouts do hit it.
//
// What must not move: no observation id. Keys are internal; identityParts are
// untouched, and the ids below were pinned from the parser BEFORE this change
// (a777d59) for the same inputs.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCodexJsonl, scanHistoryFiles } = require('../src/history-adapters');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-code-mode-rollout-sanitized.jsonl');
const RECORDS = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const PARENT = RECORDS[0].payload.id;
const SESSION_A = '0192cccc-3333-7000-8000-00000000cc0a';
const SESSION_B = '0192cccc-3333-7000-8000-00000000cc0b';
const CELL_TRUTH = { call_cell_1: 'success', call_cell_2: 'failed', call_cell_3: 'success', call_cell_4: 'failed',
  call_cell_5: 'success', call_cell_6: 'unknown' };

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
// A fixed synthetic path: a call with no call id has an identity that includes it.
const FILE = 'C:\\src\\example\\rollout.jsonl';
const parse = (records) => parseCodexJsonl(jsonl(records), { file: FILE, platform: 'win32' });
const edited = (record, change) => ({ ...record, payload: change({ ...record.payload }) });
// The real code-mode session under another session id; call ids untouched.
const asSession = (id, records = RECORDS) => records.map((record) => (record.type !== 'session_meta' ? record
  : edited(record, (payload) => ({ ...payload, id, session_id: id }))));
const verdicts = (observations) => Object.fromEntries(observations.map((item) => [`${item.session}/${item.callId}`, [item.id, item.status]]));
const statuses = (observations, session) => Object.fromEntries(observations.filter((item) => item.session === session)
  .map((item) => [item.callId, item.status]));

// Direct unified-exec calls, in the shapes the other history tests use.
const meta = (id, extra = {}) => ({ type: 'session_meta', payload: { id, cwd: 'C:\\src\\example', ...extra } });
const execCall = (callId, cmd) => ({ type: 'response_item', timestamp: '2026-10-13T12:00:00.000Z',
  payload: { type: 'function_call', name: 'exec_command', call_id: callId, arguments: JSON.stringify({ cmd, workdir: 'C:\\src\\example' }) } });
const execExit = (callId, exit) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId,
  output: `Chunk ID: fixture\nWall time: 0.1 seconds\nProcess exited with code ${exit}\nOutput:\nfixture witness\n` } });
const execRunning = (callId, sessionId) => ({ type: 'response_item', payload: { type: 'function_call_output', call_id: callId,
  output: `Chunk ID: fixture\nWall time: 2 seconds\nProcess running with session ID ${sessionId}\nOutput:\n` } });
const writeStdin = (callId, sessionId) => ({ type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: callId,
  arguments: JSON.stringify({ session_id: sessionId, chars: '' }) } });
// A call with no call id at all: its group key and its identity are both synthetic.
const anonymousCall = (cmd) => ({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command',
  arguments: JSON.stringify({ cmd, workdir: 'C:\\src\\example' }) } });

// PINNED FROM THE PARSER BEFORE THIS CHANGE (a777d59), for exactly these inputs.
const PINNED = {
  codeMode: {
    call_cell_1: 'codex:42bc940adda72f55eaacb46c',
    call_cell_2: 'codex:89dd27dd1668397e18e885dc',
    call_cell_3: 'codex:f7be5dd94fa25e8811a4430b',
    call_cell_4: 'codex:8f18be0b0469541954615de5',
    call_cell_5: 'codex:7664558794877e2923831fdf',
    call_cell_6: 'codex:3873e1dd9154eeb7db9ec0aa',
  },
  direct: 'codex:597ed19c89986bc29c1a7d3b',
  waited: 'codex:cee5cb6c4ff56b615babc48f',
  anonymous: 'codex:7896e5850eb8b495d1967b79',
  forkDirect: 'codex:053288d27e2e16dde692fa9f',
};
const directSession = (session, exit, extra) => [meta(session, extra), execCall('call_shared', 'git status'), execExit('call_shared', exit)];
const waitedSession = (session, exit) => [meta(session), execCall('call_start', 'git log'), execRunning('call_start', 8000),
  writeStdin('call_poll', 8000), execExit('call_poll', exit)];
const forkFile = (records) => [meta('0192cccc-3333-7000-8000-00000000ccf0', { forked_from_id: PARENT }), ...records];

test('observation identity does not move: every id below was pinned before this change', () => {
  const single = parse(RECORDS);
  assert.deepEqual(Object.fromEntries(single.map((item) => [item.callId, item.id])), PINNED.codeMode, 'the real code-mode session');
  assert.equal(parse(directSession(SESSION_A, 0))[0].id, PINNED.direct, 'a direct exec_command call');
  assert.equal(parse(waitedSession(SESSION_A, 0))[0].id, PINNED.waited, 'a unified-exec call finished by write_stdin');
  assert.equal(parse([meta(SESSION_A), anonymousCall('git status')])[0].id, PINNED.anonymous, 'a call with no call id (synthetic identity)');
  // A forked rollout files everything after its head under the PARENT (9abc330), so
  // the copy of a parent call keeps the parent's identity.
  assert.equal(parse(forkFile(directSession(PARENT, 0)))[0].id, PINNED.forkDirect, 'a call after a fork head');
  assert.equal(PINNED.forkDirect, parse(directSession(PARENT, 0))[0].id, 'and it is the parent file\'s own id');
});

test('two sessions in one file that reuse every call id keep their own groups, ids and verdicts', () => {
  const alone = verdicts([...parse(asSession(SESSION_A)), ...parse(asSession(SESSION_B))]);
  const both = parse([...asSession(SESSION_A), ...asSession(SESSION_B)]);
  assert.equal(both.length, 12, 'six cells per session, none merged');
  assert.deepEqual(verdicts(both), alone, 'each session reads exactly as it reads alone, ids included');
  assert.deepEqual(statuses(both, SESSION_A), CELL_TRUTH);
  assert.deepEqual(statuses(both, SESSION_B), CELL_TRUTH);
  // A failure in one session cannot reach the other's call of the same id, in
  // either order: B's cell 1 carries cell 2's real failing output under cell 1's id.
  const failing = RECORDS.find((record) => record.payload?.type === 'custom_tool_call_output' && record.payload.call_id === 'call_cell_2');
  const failedOne = asSession(SESSION_B).map((record) => (record.payload?.type === 'custom_tool_call_output' && record.payload.call_id === 'call_cell_1'
    ? edited(failing, (payload) => ({ ...payload, call_id: 'call_cell_1' })) : record));
  for (const order of [[...asSession(SESSION_A), ...failedOne], [...failedOne, ...asSession(SESSION_A)]]) {
    const parsed = parse(order);
    assert.equal(statuses(parsed, SESSION_A).call_cell_1, 'success', 'the other session\'s failure stays in the other session');
    assert.equal(statuses(parsed, SESSION_B).call_cell_1, 'failed');
  }
});

test('direct and write_stdin-finished exec calls that share ids across sessions keep their own outcome', () => {
  for (const order of [[0, 1], [1, 0]]) {
    const [first, second] = order;
    const direct = parse([...directSession(SESSION_A, first), ...directSession(SESSION_B, second)]);
    assert.deepEqual([statuses(direct, SESSION_A).call_shared, statuses(direct, SESSION_B).call_shared],
      order.map((exit) => (exit === 0 ? 'success' : 'failed')), `direct exits ${order}`);
    // The process join was already scoped by session; its group was not, so a
    // shared start id made the group two-headed and neither process result landed.
    const waited = parse([...waitedSession(SESSION_A, first), ...waitedSession(SESSION_B, second)]);
    assert.deepEqual([statuses(waited, SESSION_A).call_start, statuses(waited, SESSION_B).call_start],
      order.map((exit) => (exit === 0 ? 'success' : 'failed')), `write_stdin exits ${order}`);
  }
  // The scope is the session id, not the session_meta record: the same id stated
  // again between a call and its result (as a writer re-stating its head would)
  // is the same session, and the call still meets its result.
  const restated = parse([meta(SESSION_A), execCall('call_shared', 'git status'), meta(SESSION_A), execExit('call_shared', 1)]);
  assert.deepEqual(restated.map((item) => [item.session, item.status]), [[SESSION_A, 'failed']]);
});

// THE APPEND-SLICE IDENTITY RULE (9abc330), on a forked head: an append slice is
// seeded with the in-order session after the head (the parent), and the group key
// uses that same session, so a group whose call is before the cursor and whose
// result is after it lands in the same group, under the same id, with the verdict
// a full read reaches. The bounded widen is exercised by the one-byte overlap, and
// the seed itself by an overlap that starts exactly at the tail call: that slice
// holds the call and its result and nothing before them, so it is parsed from the
// seed alone, with no widen back to the head.
test('a group spanning an append cursor in a forked rollout reaches the full-read id and verdict', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-session-groups-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const records = forkFile([...asSession(PARENT), execCall('call_tail', 'git status'), execExit('call_tail', 1)]);
  const fullFile = path.join(root, 'full', 'rollout.jsonl');
  fs.mkdirSync(path.dirname(fullFile), { recursive: true });
  fs.writeFileSync(fullFile, jsonl(records));
  const full = new Map(scanHistoryFiles({ codexRoots: [path.dirname(fullFile)], claudeRoots: [] }).observations
    .map((item) => [item.id, [item.session, item.callId, item.status]]));
  assert.equal(full.size, 7, 'precondition: six cells and the tail call');
  for (const [, [session]] of full) assert.equal(session, PARENT, 'precondition: everything after the fork head is the parent\'s');
  const cuts = [
    ['between cell 1 and its output', records.findIndex((record) => record.payload?.type === 'custom_tool_call' && record.payload.call_id === 'call_cell_1') + 1],
    ['between the tail call and its output', records.findIndex((record) => record.payload?.call_id === 'call_tail') + 1],
  ];
  let directory = 0;
  for (const [label, cut] of cuts) {
    for (const overlapBytes of [256 * 1024, 1]) {
      const file = path.join(root, `case-${directory += 1}`, 'rollout.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, jsonl(records.slice(0, cut)));
      const first = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], overlapBytes });
      fs.appendFileSync(file, jsonl(records.slice(cut)));
      const second = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], cursors: first.cursors, overlapBytes });
      assert.equal(second.files[0].mode, 'append', `${label}: precondition, an append slice`);
      assert.equal(second.files[0].unmatchedResults, undefined, `${label} (overlap ${overlapBytes}): nothing left unmatched`);
      const latest = new Map();
      for (const item of [...first.observations, ...second.observations]) latest.set(item.id, [item.session, item.callId, item.status]);
      assert.deepEqual(latest, full, `${label} (overlap ${overlapBytes}): the same ids, sessions and verdicts as a full read`);
    }
  }
  {
    const tail = records.find((record) => record.payload?.type === 'function_call' && record.payload.call_id === 'call_tail');
    const cut = records.indexOf(tail) + 1;
    // The line, its newline, and one byte of the line before, which the slice
    // start then skips forward from: the slice begins at the tail call's record.
    const overlapBytes = Buffer.byteLength(JSON.stringify(tail)) + 2;
    const file = path.join(root, 'seeded', 'rollout.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl(records.slice(0, cut)));
    const first = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], overlapBytes });
    fs.appendFileSync(file, jsonl(records.slice(cut)));
    const second = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], cursors: first.cursors, overlapBytes });
    assert.equal(second.files[0].mode, 'append');
    assert.ok(second.files[0].bytesRead < fs.statSync(file).size / 2, 'precondition: the slice starts far past the head, so only the seed can name the session');
    assert.equal(second.files[0].unmatchedResults, undefined, 'the slice needed no widen');
    const delivered = second.observations.filter((item) => item.callId === 'call_tail');
    assert.equal(delivered.length, 1, 'the tail call is delivered with its result');
    assert.deepEqual([delivered[0].id, delivered[0].session, delivered[0].callId, delivered[0].status],
      [...full.entries()].filter(([, [, callId]]) => callId === 'call_tail').map(([id, value]) => [id, ...value])[0],
      'under the parent session, the full-read id and verdict');
  }
});
