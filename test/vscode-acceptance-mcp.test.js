'use strict';

// THE VS CODE MCP ACCEPTANCE SUITE READS BOTH ROLLOUT SHAPES (2026-10-13).
//
// scripts/vscode-acceptance/mcp.js drives real Codex MCP calls through the VS Code
// driver and checks what each rollout recorded. It asserted the 0.145.0 record
// alone -- an event_msg/mcp_tool_call_end with {invocation, result: {Ok|Err}} --
// and Codex 0.161.0 writes none: each outcome is an event_msg/item_completed whose
// item is {type: "McpToolCall", server, tool, status, result | error}, measured by
// scripts/check-codex-mcp-runtime.js (6eb35c1). So every case would have failed on
// 0.161.0 before any product behaviour was checked. Both now go through one
// assertion, assertMcpRolloutOutcome in the MCP harness, and the suite opts into
// the harness's instruction-isolation canary when its workspace is in a temp tree.
//
// The suite itself needs a live VS Code window and cannot run here (the driver is
// not run in this change), so these tests prove the assertion it now calls on the
// real 0.161.0 rollouts and on the same outcomes in the 0.145.0 shape, and pin
// that the suite's source calls it rather than its old inline check.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { assertMcpRolloutOutcome, workspaceUnderTempTree } = require('../scripts/check-codex-mcp-runtime');
const { isolateWorkspaceInstructions } = require('../scripts/check-codex-runtime');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-mcp-item-completed-sanitized.jsonl');
const RECORDS = fs.readFileSync(FIXTURE, 'utf8').split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const SUITE = path.join(__dirname, '..', 'scripts', 'vscode-acceptance', 'mcp.js');
const HARNESS = path.join(__dirname, '..', 'scripts', 'check-codex-mcp-runtime.js');
const NEW_SHAPE = 'item_completed/McpToolCall';
const OLD_SHAPE = 'mcp_tool_call_end';

// The five real case rollouts, in the harness's case order, with what each did.
const EXPECTED = [
  { server: 'fixture', tool: 'succeed', executed: false, isError: false, status: 'failed' },
  { server: 'fixture', tool: 'succeed', executed: true, isError: false, status: 'completed', witness: 'acolyte-mcp-succeed-witness' },
  { server: 'fixture', tool: 'fail', executed: true, isError: true, status: 'failed', witness: 'acolyte-mcp-fail-witness' },
  { server: 'fixture', tool: 'neighbor', executed: false, isError: false, status: 'failed' },
  { server: 'fixture', tool: 'succeed', executed: true, isError: false, status: 'completed', witness: 'acolyte-mcp-succeed-witness' },
];

function sessions() {
  const out = [];
  for (const record of RECORDS) {
    if (record.type === 'session_meta') out.push([]);
    out[out.length - 1].push(record);
  }
  return out;
}
const isItem = (record) => record.type === 'event_msg' && record.payload?.type === 'item_completed' && record.payload.item?.type === 'McpToolCall';
// The same outcome as the 0.145.0 record (the shape test/codex-mcp-history.test.js
// pins), in the item's place: Ok with the item's own result, or Err with its error.
function oldEnd(item) {
  return { timestamp: '2026-09-28T18:04:44.323Z', type: 'event_msg', payload: {
    type: 'mcp_tool_call_end', call_id: item.id, invocation: { server: item.server, tool: item.tool, arguments: {} },
    duration: { secs: 0, nanos: 1000000 },
    result: item.result ? { Ok: { content: item.result.content, isError: item.result.isError } } : { Err: item.error.message } } };
}
const asOldShape = (records) => records.map((record) => (isItem(record) ? oldEnd(record.payload.item) : record));
const withItem = (records, change) => records.map((record) => (!isItem(record) ? record
  : { ...record, payload: { ...record.payload, item: change({ ...record.payload.item }) } }));

test('the shared assertion accepts every real 0.161.0 MCP outcome as Codex recorded it', () => {
  const all = sessions();
  assert.equal(all.length, EXPECTED.length, 'precondition: five real case rollouts');
  // The suite's former check, in effect: exactly one mcp_tool_call_end, or fail.
  const formerCheck = (records) => records.filter((item) => item.type === 'event_msg' && item.payload.type === OLD_SHAPE).length === 1;
  for (const [index, records] of all.entries()) {
    assert.equal(records[0].payload.cli_version, '0.161.0');
    assert.equal(formerCheck(records), false, `WITNESS the suite's former check rejects real 0.161.0 case ${index + 1}`);
    assert.equal(assertMcpRolloutOutcome(records, EXPECTED[index], `case ${index + 1}`), NEW_SHAPE);
  }
});

test('the same outcomes in the 0.145.0 record shape pass the same assertion', () => {
  for (const [index, records] of sessions().entries()) {
    const old = asOldShape(records);
    assert.equal(old.some(isItem), false, 'precondition: the 0.161.0 item is gone');
    // The old record has no status of its own; the expectation's is simply unused.
    assert.equal(assertMcpRolloutOutcome(old, EXPECTED[index], `case ${index + 1}`), OLD_SHAPE);
  }
});

test('a rollout carrying both shapes passes only when they agree', () => {
  const [, ran] = sessions();
  const item = ran.find(isItem).payload.item;
  const both = [...ran, oldEnd(item)];
  assert.equal(assertMcpRolloutOutcome(both, EXPECTED[1]), `${OLD_SHAPE}+${NEW_SHAPE}`);
  const disagree = [...ran, oldEnd({ ...item, result: { ...item.result, isError: true } })];
  assert.throws(() => assertMcpRolloutOutcome(disagree, EXPECTED[1]), /mcp_tool_call_end isError/);
});

test('the shared assertion fails a rollout that disagrees with what the case did, in either shape', () => {
  const [declined, ran, failing] = sessions();
  for (const shape of [(records) => records, asOldShape]) {
    const label = shape === asOldShape ? 'old shape' : 'new shape';
    assert.throws(() => assertMcpRolloutOutcome(shape(ran), { ...EXPECTED[1], tool: 'neighbor' }), /tool/, `${label}: the wrong tool`);
    assert.throws(() => assertMcpRolloutOutcome(shape(ran), { ...EXPECTED[1], server: 'other' }), /server/, `${label}: the wrong server`);
    assert.throws(() => assertMcpRolloutOutcome(shape(declined), { ...EXPECTED[1], status: undefined }), /executed call/, `${label}: a decline is not a run`);
    assert.throws(() => assertMcpRolloutOutcome(shape(ran), { ...EXPECTED[0], status: undefined }), /declined call|ran nothing/, `${label}: a run is not a decline`);
    assert.throws(() => assertMcpRolloutOutcome(shape(failing), { ...EXPECTED[2], isError: false }), /isError/, `${label}: isError must match`);
    assert.throws(() => assertMcpRolloutOutcome(shape(ran), { ...EXPECTED[1], witness: 'absent-witness' }), /own result/, `${label}: the result content`);
    assert.throws(() => assertMcpRolloutOutcome(shape(ran).filter((record) => !isItem(record) && record.payload?.type !== OLD_SHAPE), EXPECTED[1]),
      /one of the two known shapes/, `${label}: no outcome recorded at all`);
  }
  // Only the new shape has a status of its own, and it has to match.
  assert.throws(() => assertMcpRolloutOutcome(ran, { ...EXPECTED[1], status: 'failed' }), /status/);
  // A declined item that carries a result anyway is not a decline.
  assert.throws(() => assertMcpRolloutOutcome(withItem(declined, (item) => ({ ...item, result: ran.find(isItem).payload.item.result })), EXPECTED[0]),
    /ran nothing/);
  // One call recorded twice in one shape is not one outcome.
  assert.throws(() => assertMcpRolloutOutcome([...ran, ran.find(isItem)], EXPECTED[1]), /at most once per shape/);
  // Only a direct event_msg counts, as in the parser: the item nested anywhere else is not a record of the outcome.
  const nested = ran.map((record) => (isItem(record) ? { type: 'response_item', payload: record.payload } : record));
  assert.throws(() => assertMcpRolloutOutcome(nested, EXPECTED[1]), /one of the two known shapes/);
});

// The suite cannot be loaded without VS Code, so its source is what can be pinned:
// the outcome goes through the shared assertion, the 0.145.0-only filter is gone,
// and the canary check is asked for and enforced. Against the suite as it was
// before this change, every assertion here fails.
test('the acceptance suite checks the outcome through the shared assertion and opts into the canary', () => {
  const suite = fs.readFileSync(SUITE, 'utf8');
  assert.match(suite, /assertMcpRolloutOutcome\(observed\.records,/, 'the suite asserts the rollout outcome through the shared assertion');
  assert.equal(suite.includes("'mcp_tool_call_end'"), false, 'the suite no longer filters for the 0.145.0 record itself');
  assert.match(suite, /foreignInstructionCheck: mcp\.instructionIsolation/, 'the suite asks the shared case for the canary check');
  assert.match(suite, /mcp\.instructionIsolation = workspaceUnderTempTree\(workspace\)/);
  assert.match(suite, /isolateWorkspaceInstructions\(workspace\)/, 'and isolates the workspace it hands the case');
  assert.match(suite, /observed\.canaryFreeRequests, observed\.providerRequests/, 'and requires every request to have been checked');
  // The harness reads its own cases through the same assertion, so the two cannot drift.
  const harness = fs.readFileSync(HARNESS, 'utf8');
  assert.match(harness, /recordShape=assertMcpRolloutOutcome\(observed\.records,/);
});

// The suite isolates only where isolateWorkspaceInstructions would plant rather
// than refuse, so the opt-in can never turn a refusal into a failed suite, nor skip
// a workspace the helper could have isolated.
test('the canary opt-in agrees with where the isolation helper plants', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-vscode-drive-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  // drive-vscode.js's own layout: <tmp>/acolyte-vscode-drive-*/workspace.
  const workspace = path.join(root, 'workspace');
  fs.mkdirSync(workspace);
  assert.equal(workspaceUnderTempTree(workspace), true, 'the driver workspace qualifies');
  assert.doesNotThrow(() => isolateWorkspaceInstructions(workspace));
  // Directly under the temp root, outside the temp tree, or with no parent at all:
  // the helper refuses each, and the opt-in says no to each. Nothing is created.
  for (const [label, candidate] of [
    ['directly under the temp root', path.join(os.tmpdir(), 'acolyte-not-created-here')],
    ['outside the temp tree', path.join(__dirname, 'acolyte-not-a-workspace')],
    ['with a missing parent', path.join(root, 'missing-parent', 'workspace')],
  ]) {
    assert.equal(workspaceUnderTempTree(candidate), false, `${label}: no opt-in`);
    assert.throws(() => isolateWorkspaceInstructions(candidate), Error, `${label}: the helper refuses too`);
    assert.equal(fs.existsSync(candidate), false, `${label}: nothing was created`);
  }
  assert.equal(fs.existsSync(path.join(__dirname, 'AGENTS.md')), false);
});
