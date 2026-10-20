'use strict';

// CODE-MODE CELLS ON CODEX 0.162/0.163 (2026-10-20). A nested tools.exec_command(...) returns an
// object, which a script prints as a JSON part of the cell's output; 0.161.0 printed it as text with
// an "Exit code: N" line. Measured on the live-hook box that day (0.162.0-alpha.17.2 in VS Code,
// 0.163.0-alpha.10.2 in the desktop app, about 2,000 commands in 10 rollouts): every cell that ran
// several literal commands read `unknown` even with every result at exit 0, and a guardian
// rejection read as the command's failure. The shapes below are synthetic copies of those records:
// no real path, command or prompt.
//
// The rule (src/history-adapters.js customExecRunsSucceeded): results credit a cell's commands only
// when they account for every execution and all exited 0; a refusal is never a failure.

const test = require('node:test');
const assert = require('node:assert/strict');

const { parseCodexJsonl } = require('../src/history-adapters');

const HEAD_OK = 'Script completed\nWall time 0.5 seconds\nOutput:\n';
const HEAD_FAILED = 'Script failed\nWall time 0.5 seconds\nOutput:\n';
const REJECTED = 'exec_command failed: CreateProcess { message: "Rejected(\\"This action was rejected due to unacceptable risk.\\\\nReason: synthetic.\\")" }';

const meta = { type: 'session_meta', payload: { id: 'sess-0162', cwd: '/w/project', originator: 'codex_vscode', cli_version: '0.162.0-alpha.17.2' } };
const cell = (input) => ({ type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'call_1', input } });
const output = (...texts) => ({ type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'call_1',
  output: texts.map((text) => ({ type: 'input_text', text })) } });
const result = (exit, extra = {}) => ({ chunk_id: 'a1b2c3', wall_time_seconds: 0.25, exit_code: exit, original_token_count: 2, output: 'ok\r\n', ...extra });
const settled = (...results) => JSON.stringify(results.map((value, i) => ({ i, status: 'fulfilled', value })));

function statuses(...records) {
  const text = `${[meta, ...records].map((record) => JSON.stringify(record)).join('\n')}\n`;
  return parseCodexJsonl(text, { file: '/w/rollout.jsonl', tool: 'Bash' }).map((o) => `${o.command} => ${o.status}`);
}

const TWO = "const rs = await Promise.allSettled([tools.exec_command({cmd:'git status'}), tools.exec_command({cmd:'git log -1'})]);\n"
  + 'text(JSON.stringify(rs.map((r, i) => ({ i, status: r.status, value: r.value }))));';

// MUTATION: drop the customExecRunsSucceeded branch from applyCodexGroupResult and both read unknown.
test('a cell of several literal commands is credited when every one printed exit 0', () => {
  assert.deepEqual(statuses(cell(TWO), output(HEAD_OK, settled(result(0), result(0)))),
    ['git status => success', 'git log -1 => success']);
  // One result per part, as a `for ... of` after the last call prints them, reads the same.
  assert.deepEqual(statuses(cell(TWO), output(HEAD_OK, JSON.stringify(result(0)), JSON.stringify(result(0)))),
    ['git status => success', 'git log -1 => success']);
});

test('a nonzero result still fails the cell, as any failure in it did', () => {
  assert.deepEqual(statuses(cell(TWO), output(HEAD_OK, settled(result(0), result(1)))),
    ['git status => failed', 'git log -1 => failed']);
});

// MUTATION: drop `runs.length === shape.sites` from customExecRunsSucceeded and this reads success.
test('results that do not account for every call site credit nothing', () => {
  assert.deepEqual(statuses(cell(TWO), output(HEAD_OK, settled(result(0)))),
    ['git status => unknown', 'git log -1 => unknown']);
});

// MUTATION: drop `shape.straightBeforeLast` and the branched cell reads success.
test('a branch or loop before the last call site credits nothing: a site may have run twice or not at all', () => {
  const branched = "if (flag) await tools.exec_command({cmd:'git status'});\nawait tools.exec_command({cmd:'git log -1'});";
  assert.deepEqual(statuses(cell(branched), output(HEAD_OK, JSON.stringify(result(0)), JSON.stringify(result(0)))),
    ['git status => unknown', 'git log -1 => unknown']);
  const looped = "for (const x of [1, 2]) await tools.exec_command({cmd:'git status'});\nawait tools.exec_command({cmd:'git log -1'});";
  assert.deepEqual(statuses(cell(looped), output(HEAD_OK, JSON.stringify(result(0)), JSON.stringify(result(0)))),
    ['git status => unknown', 'git log -1 => unknown']);
});

test('one literal call site, however many times it ran, is credited when every run exited 0', () => {
  const loop = "for (const p of ['a', 'b', 'c']) text(await tools.exec_command({cmd:'git status'}));";
  assert.deepEqual(statuses(cell(loop), output(HEAD_OK, JSON.stringify(result(0)), JSON.stringify(result(0)), JSON.stringify(result(0)))),
    ['git status => success']);
  assert.deepEqual(statuses(cell(loop), output(HEAD_OK, JSON.stringify(result(0)), JSON.stringify(result(2)))),
    ['git status => failed']);
});

// MUTATION: drop `shape.sites !== shape.extracted` and the literal command reads success beside a
// dynamic one nothing could name.
test('a dynamic call site beside a literal one credits nothing', () => {
  const mixed = "await tools.exec_command({cmd:'git status'});\nawait tools.exec_command({cmd:`git log -${n}`});";
  assert.deepEqual(statuses(cell(mixed), output(HEAD_OK, JSON.stringify(result(0)), JSON.stringify(result(0)))),
    ['git status => unknown']);
});

test('a process still running credits nothing, and a command\'s own output is never read as a result', () => {
  assert.deepEqual(statuses(cell(TWO), output(HEAD_OK, settled(result(0), { chunk_id: 'x', wall_time_seconds: 10, session_id: 49848, output: '' }))),
    ['git status => unknown', 'git log -1 => unknown']);
  // A result whose stdout holds a failed result's JSON: the string is not parsed.
  const nested = result(0, { output: JSON.stringify(result(1)) });
  assert.deepEqual(statuses(cell(TWO), output(HEAD_OK, settled(result(0), nested))),
    ['git status => success', 'git log -1 => success']);
});

// MUTATION: return false from codeModeRefusedAfterOutput and both read failed.
test('a refusal after printed results withholds the cell; a printed nonzero result still fails it', () => {
  const sequential = "text(await tools.exec_command({cmd:'git status'}));\ntext(await tools.exec_command({cmd:'git push'}));";
  assert.deepEqual(statuses(cell(sequential), output(HEAD_FAILED, JSON.stringify(result(0)), `Script error:\n${REJECTED}`)),
    ['git status => unknown', 'git push => unknown']);
  assert.deepEqual(statuses(cell(sequential), output(HEAD_FAILED, JSON.stringify(result(1)), `Script error:\n${REJECTED}`)),
    ['git status => failed', 'git push => failed']);
  // One call site in a loop, run once and then refused: never credited, though its one printed run
  // exited 0. MUTATION: drop `!result.refused` from applyCodexGroupResult and this reads success.
  const loop = "for (const p of ['a', 'b']) text(await tools.exec_command({cmd:'git push'}));";
  assert.deepEqual(statuses(cell(loop), output(HEAD_FAILED, JSON.stringify(result(0)), `Script error:\n${REJECTED}`)),
    ['git push => unknown']);
  // Control: a script error that is not a refusal fails the cell, as before.
  assert.deepEqual(statuses(cell(sequential), output(HEAD_FAILED, JSON.stringify(result(0)), 'Script error:\nTypeError: x is not a function')),
    ['git status => failed', 'git push => failed']);
  // Control: the guardian rejection alone, in the bare two-part shape, is withheld too.
  assert.deepEqual(statuses(cell("text(await tools.exec_command({cmd:'git push'}));"), output(HEAD_FAILED, `Script error:\n${REJECTED}`)),
    ['git push => unknown']);
});
