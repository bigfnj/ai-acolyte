'use strict';

// MCP OUTCOMES IN THE SHAPE CODEX 0.161.0 WRITES.
//
// Codex 0.145.0 recorded an MCP outcome as `event_msg/mcp_tool_call_end` with
// {invocation, result: {Ok|Err}}, the only shape codexMcpObservation read. Measured
// 2026-10-13 on codex-cli 0.161.0 (Windows) by scripts/check-codex-mcp-runtime.js:
// that record is gone, and each outcome is an `event_msg/item_completed` whose item is
// {type: "McpToolCall", id, server, tool, status, result: {content, isError}}, or
// {status: "failed", error: {message}} for a declined call. The parser saw 0 of 5 real
// outcomes (evidence acolyte-codex-mcp-runtime-ddsfLK), so reviewed-MCP Auto Learn
// learned nothing from 0.161.0 history.
//
// The fixture is a sanitized copy of the six case rollouts the harness produced, one
// session after another in case order:
//
//   dd01  default-prompt-decline        declined at the prompt      -> unknown
//   dd02  exact-approved-success        approved by config, ran     -> success
//   dd03  exact-approved-failure        approved, tool isError true -> failed
//   dd04  neighbor-remains-prompt       declined at the prompt      -> unknown
//   dd05  single-call-reviewed-success  accepted once, ran          -> success
//   dd06  exact-approved-server-error   approved, the server failed -> failed
//                                       the call (JSON-RPC error)
//
// A DECLINED CALL IS NO EVIDENCE (2026-10-13). The two declines read `failed` until
// then; the tool never ran (the server log shows no tools/call), so they are withheld,
// as a declined shell call already is. dd06 was added beside them the same day: Codex
// writes a call the server failed in the SAME structure as a decline -- status failed,
// an `error`, no `result` -- and only the message tells them apart, so it stays
// `failed`. dd01-dd05 are byte-identical to the fixture's first version.
//
// Regenerate with (two consecutive runs wrote byte-identical files):
//   node scripts/check-codex-mcp-runtime.js --write-fixture test/fixtures/codex-mcp-item-completed-sanitized.jsonl
//
// test/codex-mcp-history.test.js keeps pinning the 0.145.0 shape; it is unchanged.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCodexJsonl, scanHistoryFiles } = require('../src/history-adapters');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-mcp-item-completed-sanitized.jsonl');
const TEXT = fs.readFileSync(FIXTURE, 'utf8');
const RECORDS = TEXT.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const CASES = [
  ['0192dddd-4444-7000-8000-00000000dd01', 'succeed', 'unknown'],
  ['0192dddd-4444-7000-8000-00000000dd02', 'succeed', 'success'],
  ['0192dddd-4444-7000-8000-00000000dd03', 'fail', 'failed'],
  ['0192dddd-4444-7000-8000-00000000dd04', 'neighbor', 'unknown'],
  ['0192dddd-4444-7000-8000-00000000dd05', 'succeed', 'success'],
  ['0192dddd-4444-7000-8000-00000000dd06', 'crash', 'failed'],
];
// The two measured error messages, as Codex 0.161.0 wrote them.
const DECLINED = 'user rejected MCP tool call';
const SERVER_ERROR = 'tool call error: tool call failed for `fixture/crash`\n\nCaused by:\n    Mcp error: -32603: acolyte-mcp-crash-witness';

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const parse = (records) => parseCodexJsonl(jsonl(records), { file: FIXTURE, platform: 'win32' });
const mcp = (records) => parse(records).filter((observation) => observation.kind === 'codex-mcp');

// One real rollout per case, cut at its session_meta.
function sessions() {
  const out = [];
  for (const record of RECORDS) {
    if (record.type === 'session_meta') out.push([]);
    out[out.length - 1].push(record);
  }
  return out;
}
const completion = (records) => records.find((record) => record.type === 'event_msg' &&
  record.payload.type === 'item_completed' && record.payload.item?.type === 'McpToolCall');
// The real record with its item replaced, everything else as Codex wrote it.
function withItem(records, change) {
  const target = completion(records);
  return records.map((record) => (record !== target ? record
    : { ...record, payload: { ...record.payload, item: change({ ...record.payload.item }) } }));
}

test('the fixture really is six 0.161.0 rollouts in the new shape and none in the old', () => {
  const all = sessions();
  assert.equal(all.length, 6);
  for (const [index, records] of all.entries()) {
    const meta = records[0].payload;
    assert.equal(meta.cli_version, '0.161.0', 'the fixture names the build it came from');
    assert.equal(meta.id, CASES[index][0]);
    const items = records.filter((record) => record.type === 'event_msg' && record.payload.item?.type === 'McpToolCall');
    assert.equal(items.length, 1, `WITNESS session ${index + 1} records its outcome as one McpToolCall item`);
    assert.equal(records.filter((record) => record.payload?.type === 'mcp_tool_call_end').length, 0,
      'WITNESS 0.161.0 wrote no mcp_tool_call_end');
    const call = records.find((record) => record.payload?.type === 'function_call');
    assert.equal(call.payload.namespace, 'mcp__fixture');
    assert.equal(items[0].payload.item.id, call.payload.call_id, 'WITNESS the item id IS the call id');
  }
  // The three measured outcome shapes, as Codex wrote them.
  const shape = (records) => { const { status, result, error } = completion(records).payload.item;
    return [status, result ? result.isError : null, error ? 'error' : null]; };
  assert.deepEqual(all.map(shape), [
    ['failed', null, 'error'], ['completed', false, null], ['failed', true, null],
    ['failed', null, 'error'], ['completed', false, null], ['failed', null, 'error']]);
  // A decline and a server error are the same structure; only the words differ.
  for (const [index, message] of [[0, DECLINED], [3, DECLINED], [5, SERVER_ERROR]]) {
    const { item } = completion(all[index]).payload;
    assert.equal(Object.hasOwn(item, 'result'), false, `WITNESS session ${index + 1} writes no result key at all`);
    assert.deepEqual(item.error, { message }, `WITNESS session ${index + 1}'s exact error`);
  }
});

test('every real 0.161.0 MCP outcome becomes one observation with its true status', () => {
  const all = sessions();
  for (const [index, records] of all.entries()) {
    const [session, tool, status] = CASES[index];
    const observations = mcp(records);
    assert.equal(observations.length, 1, `case ${index + 1} is seen`);
    const [observation] = observations;
    assert.equal(observation.status, status, `case ${index + 1} (${tool}) is ${status}`);
    assert.equal(observation.source, 'codex');
    assert.equal(observation.tool, 'CodexMCP', 'Codex MCP identity never becomes a Claude permission');
    assert.equal(observation.command, 'call');
    assert.equal(observation.mcpServer, 'fixture');
    assert.equal(observation.mcpTool, tool);
    assert.equal(observation.callId, 'call_fixture');
    assert.equal(observation.session, session);
    assert.equal(observation.cwd, 'C:\\src\\example');
    // Nothing else in the rollout is an observation: the namespaced function_call and
    // its output are MCP plumbing, and the UserMessage/AgentMessage items are not tools.
    assert.equal(parse(records).length, 1, `case ${index + 1}: only the MCP outcome is observed`);
  }
  const whole = mcp(RECORDS);
  assert.deepEqual(whole.map((observation) => observation.status), CASES.map(([, , status]) => status));
  assert.equal(new Set(whole.map((observation) => observation.id)).size, 6, 'one call id, six sessions, six identities');
});

test('raw MCP arguments and result content never leave the parser', () => {
  const observations = mcp(RECORDS);
  const text = JSON.stringify(observations);
  for (const witness of ['acolyte-mcp-succeed-witness', 'acolyte-mcp-fail-witness', 'user rejected MCP tool call', 'acolyte-mcp-crash-witness']) {
    assert.ok(TEXT.includes(witness), `precondition: the fixture carries ${witness}`);
    assert.equal(text.includes(witness), false, `${witness} left the parser`);
  }
  for (const observation of observations) {
    for (const key of ['arguments', 'result', 'content', 'error', 'readOnlyHint']) assert.equal(observation[key], undefined);
    assert.equal(Object.keys(observation).includes('_callOffset'), false);
    assert.equal(observation._callOffset, observation._resultOffset, 'one record is both the call and its result');
  }
});

test('an McpToolCall outcome counts only when Codex states it, failure first', () => {
  const [, success] = sessions();
  const status = (change) => mcp(withItem(success, change)).map((observation) => observation.status);
  assert.deepEqual(status((item) => item), ['success'], 'control: the real record');
  assert.deepEqual(status((item) => ({ ...item, result: { ...item.result, isError: true } })), ['failed'],
    'isError true is a failure even under status completed');
  assert.deepEqual(status((item) => ({ ...item, error: { message: 'transport closed' } })), ['failed'],
    'an error beside a result is a failure, as Err beside Ok is');
  assert.deepEqual(status((item) => { const copy = { ...item, status: 'failed' }; delete copy.result; return copy; }), ['failed'],
    'a failed status with neither result nor error is still Codex saying it failed');
  for (const [label, change] of [
    ['isError missing', (item) => ({ ...item, result: { content: item.result.content } })],
    ['isError a string', (item) => ({ ...item, result: { ...item.result, isError: 'false' } })],
    ['isError a number', (item) => ({ ...item, result: { ...item.result, isError: 0 } })],
    ['result not an object', (item) => ({ ...item, result: 'ok' })],
    ['no result at all', (item) => { const copy = { ...item }; delete copy.result; return copy; }],
    ['status still in progress', (item) => ({ ...item, status: 'inProgress' })],
    ['status missing', (item) => { const copy = { ...item }; delete copy.status; return copy; }],
  ]) assert.deepEqual(status(change), ['unknown'], `${label}: no authoritative outcome, no success`);
});

// A DECLINE IS NO EVIDENCE, AND ONLY THE MEASURED DECLINE IS ONE (2026-10-13). The
// server-error session is the control that matters: Codex wrote it in the decline's
// own structure, so a reader keyed on structure alone would withhold a real failure.
test('a declined call is withheld, and only the exact measured decline is one', () => {
  const all = sessions();
  const [declined] = all;
  const serverError = all[5];
  const status = (records, change) => mcp(withItem(records, change)).map((observation) => observation.status);
  assert.deepEqual(status(declined, (item) => item), ['unknown'], 'the real decline: the tool never ran');
  assert.deepEqual(status(all[3], (item) => item), ['unknown'], 'the neighbouring tool\'s real decline');
  assert.deepEqual(status(serverError, (item) => item), ['failed'], 'control: a call the server failed, same structure, is a failure');
  assert.deepEqual(status(serverError, (item) => ({ ...item, error: { message: DECLINED } })), ['unknown'],
    'the same record with the decline\'s words is a decline: the words alone decide');
  for (const [label, change] of [
    ['the message capitalised', (item) => ({ ...item, error: { message: 'User rejected MCP tool call' } })],
    ['the message with trailing text', (item) => ({ ...item, error: { message: `${DECLINED}.` } })],
    ['the server error\'s message', (item) => ({ ...item, error: { message: SERVER_ERROR } })],
    ['a second key in the error', (item) => ({ ...item, error: { message: DECLINED, code: -32603 } })],
    ['the error as a bare string', (item) => ({ ...item, error: DECLINED })],
    ['a null result beside it', (item) => ({ ...item, result: null })],
    ['a result beside it', (item) => ({ ...item, result: { content: [], isError: false } })],
    ['a status other than failed', (item) => ({ ...item, status: 'completed' })],
    ['no status at all', (item) => { const copy = { ...item }; delete copy.status; return copy; }],
  ]) assert.deepEqual(status(declined, change), ['failed'], `${label}: not the measured decline, so the recorded error is a failure`);
});

test('only a direct, well-formed McpToolCall completion confers MCP identity', () => {
  const [, success] = sessions();
  const real = completion(success);
  for (const [label, record] of [
    ['inside a response_item', { ...real, type: 'response_item' }],
    ['under another event type', { ...real, payload: { ...real.payload, type: 'item_started' } }],
    ['nested in a message', { type: 'event_msg', payload: { type: 'agent_message', message: real.payload } }],
    ['an unknown item type', { ...real, payload: { ...real.payload, item: { ...real.payload.item, type: 'CommandExecution' } } }],
    ['a lowercase item type', { ...real, payload: { ...real.payload, item: { ...real.payload.item, type: 'mcpToolCall' } } }],
    ['no item', { ...real, payload: { type: 'item_completed' } }],
  ]) assert.deepEqual(mcp([success[0], record]), [], `${label} is ignored`);
  for (const [label, change] of [
    ['an empty id', (item) => ({ ...item, id: '' })],
    ['a numeric id', (item) => ({ ...item, id: 7 })],
    ['an oversized id', (item) => ({ ...item, id: 'x'.repeat(513) })],
    ['a server with a space', (item) => ({ ...item, server: 'two words' })],
    ['a path-like server', (item) => ({ ...item, server: '../fixture' })],
    ['a missing tool', (item) => { const copy = { ...item }; delete copy.tool; return copy; }],
    ['an object tool', (item) => ({ ...item, tool: { name: 'succeed' } })],
  ]) assert.deepEqual(mcp(withItem(success, change)), [], `${label} confers no identity`);
});

// The old record's id is stableHash('codex-mcp', session, call_id). Pinned from the
// parser before this change, for this session and call id, so the old shape is proven
// to parse exactly as it did and the new shape is proven to land on the same identity.
const PINNED_OLD_SHAPE_ID = 'codex:716a610061674ce24a251479';
const OLD_SESSION = '0192dddd-4444-7000-8000-00000000dd01';
const oldEnd = (result, server = 'fixture', tool = 'succeed') => ({ timestamp: '2026-09-28T18:04:44.323Z', type: 'event_msg',
  payload: { type: 'mcp_tool_call_end', call_id: 'call_fixture', invocation: { server, tool, arguments: {} }, result } });
const OK = { Ok: { content: [{ type: 'text', text: 'w' }], isError: false } };

test('both shapes of one call are one observation, and the old shape parses as it always did', () => {
  const [declined, success] = sessions();
  // Control: the 0.145.0 shape alone, unchanged identity and outcome.
  const old = mcp([declined[0], oldEnd(OK)]);
  assert.equal(old.length, 1);
  assert.equal(old[0].id, PINNED_OLD_SHAPE_ID, 'the 0.145.0 identity has not moved');
  assert.equal(old[0].status, 'success');
  // The 0.145.0 decline is no evidence either (2026-10-13; it read `failed`), and
  // keeps its identity; any other Err is still a failure.
  const oldDecline = mcp([declined[0], oldEnd({ Err: DECLINED })]);
  assert.deepEqual([oldDecline[0].id, oldDecline[0].status], [PINNED_OLD_SHAPE_ID, 'unknown']);
  assert.equal(mcp([declined[0], oldEnd({ Err: 'transport closed' })])[0].status, 'failed');
  // The 0.161.0 record of the same call in the same session lands on the same id.
  const fresh = mcp(declined);
  assert.equal(fresh[0].id, PINNED_OLD_SHAPE_ID, 'WITNESS one call, one identity, whichever shape named it');
  // A rollout carrying both shapes counts the call once. A decline beside a
  // success is a contradiction and is withheld, either way round; a failure
  // beside a decline still wins.
  const both = mcp([...declined, oldEnd(OK)]);
  assert.equal(both.length, 1, 'both shapes of one call are not two calls');
  assert.equal(both[0].status, 'unknown', 'a later success cannot outweigh the recorded decline');
  const ran = success.map((record) => (record.type === 'session_meta'
    ? { ...record, payload: { ...record.payload, id: OLD_SESSION, session_id: OLD_SESSION } } : record));
  assert.equal(mcp([...ran, oldEnd({ Err: DECLINED })])[0].status, 'unknown', 'nor can an earlier success');
  assert.equal(mcp([...declined, oldEnd({ Ok: { content: [], isError: true } })])[0].status, 'failed',
    'a decline beside a recorded failure: failure wins, as it always does');
  assert.equal(mcp([...declined, ...declined.filter((record) => record === completion(declined))])[0].status, 'unknown',
    'a decline recorded twice is still one decline');
  const agree = mcp([...ran, oldEnd(OK)]);
  assert.equal(agree.length, 1);
  assert.equal(agree[0].status, 'success');
  assert.equal(agree[0].id, PINNED_OLD_SHAPE_ID);
  // Disagreeing identities for one call withhold rather than pick.
  const conflict = mcp([...ran, oldEnd(OK, 'fixture', 'neighbor')]);
  assert.equal(conflict.length, 1);
  assert.equal(conflict[0].status, 'unknown', 'conflicting server/tool for one call cannot earn success');
});

test('an appended 0.161.0 completion is read once and keeps its identity across a full re-read', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-item-completed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl');
  const [, success] = sessions();
  const cut = success.indexOf(completion(success));
  fs.writeFileSync(file, jsonl(success.slice(0, cut)));
  const first = scanHistoryFiles({ codexRoots: [root], claudeRoots: [], overlapBytes: 64 });
  assert.equal(first.observations.length, 0, 'the call alone is not an outcome');
  fs.appendFileSync(file, jsonl(success.slice(cut)));
  const second = scanHistoryFiles({ codexRoots: [root], claudeRoots: [], cursors: first.cursors, overlapBytes: 64 });
  assert.equal(second.observations.length, 1, 'WITNESS the appended completion is ingested');
  assert.equal(second.observations[0].status, 'success');
  assert.equal(second.observations[0].session, CASES[1][0], 'the append slice is seeded with the head session');
  const unchanged = scanHistoryFiles({ codexRoots: [root], claudeRoots: [], cursors: second.cursors, overlapBytes: 64 });
  assert.equal(unchanged.observations.length, 0, 'an unchanged transcript is not re-observed');
  const full = scanHistoryFiles({ codexRoots: [root], claudeRoots: [] });
  assert.deepEqual(full.observations.map((item) => [item.id, item.status]), second.observations.map((item) => [item.id, item.status]));
});

// THE SANITIZATION GATE, as for the other real-rollout fixtures.
test('the MCP fixture leaks nothing about the machine that produced it', () => {
  const lower = TEXT.toLowerCase();
  const username = (os.userInfo().username || '').toLowerCase();
  const hostname = (os.hostname() || '').toLowerCase();
  if (username.length >= 3) assert.equal(lower.includes(username), false, 'the fixture names the current user');
  if (hostname.length >= 3) assert.equal(lower.includes(hostname), false, 'the fixture names this machine');
  for (const marker of ['users\\\\', 'users/', '/home/', 'appdata', 'temp\\\\', '/tmp/', 'onedrive', '~1', 'agents.md',
    'instructions>', 'skills', 'win_devtools']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  for (const marker of ['accent' + 'ure', '.ai-work', 'ai-platform', 'grimoire']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  const kinds = new Set(RECORDS.map((record) => [record.type, record.payload?.type].filter(Boolean).join('/')));
  assert.deepEqual([...kinds].sort(), ['event_msg/item_completed', 'event_msg/task_complete', 'response_item/function_call',
    'response_item/function_call_output', 'session_meta', 'turn_context'], 'only the record kinds the parser reads survive');
  let paths = 0;
  for (const match of TEXT.matchAll(/[A-Za-z]:\\\\[^"\s,}]*/g)) {
    assert.match(match[0], /^C:\\\\src\\\\example$/, `unexpected absolute path ${match[0]}`);
    paths += 1;
  }
  assert.equal(paths, 12, 'WITNESS the path scan found the two synthetic cwds per session');
});
