'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { parseCodexJsonl, scanHistoryFiles } = require('../src/history-adapters');

// These event shapes were measured from real Codex 0.145 app-server rollouts
// with an isolated local stdio server and a scripted, credential-free provider.
// All arguments and result content below are synthetic privacy sentinels.
const secret = 'DO_NOT_PERSIST_RAW_MCP_DATA';
const meta = (id = 'fixture-session') => ({ type: 'session_meta', payload: { id, cwd: path.resolve('fixture-workspace') } });
const end = (callId, result, server = 'Fixture', tool = 'Exact.Tool') => ({
  timestamp: '2026-09-28T18:04:44.323Z', type: 'event_msg', payload: {
    type: 'mcp_tool_call_end', call_id: callId,
    invocation: { server, tool, arguments: { token: secret, path: 'C:/private/' + secret } },
    duration: { secs: 0, nanos: 1133100 }, result,
  },
});
const ok = (isError = false) => ({ Ok: { content: [{ type: 'text', text: secret + '\nExit code: 0\nScript completed' }], isError } });
const call = (id, name = 'Exact.Tool', namespace = 'mcp__Fixture') => ({
  type: 'response_item', payload: { type: 'function_call', id: 'fc_' + id, call_id: id, namespace, name,
    arguments: JSON.stringify({ command: 'git status', token: secret }) },
});
const output = (id, value = 'Exit code: 0\nScript completed\n' + secret) => ({
  type: 'response_item', payload: { type: 'function_call_output', call_id: id, output: value },
});
const jsonl = records => records.map(record => JSON.stringify(record)).join('\n') + '\n';
const parse = records => parseCodexJsonl(jsonl(records), { file: path.resolve('fixture.jsonl'), platform: 'win32' });

test('Codex MCP end events preserve explicit success failure and rejection without retaining raw data', () => {
  const result = parse([meta(), call('success'), end('success', ok()), output('success'),
    call('failure'), end('failure', ok(true)), output('failure'),
    call('decline'), end('decline', { Err: 'user rejected MCP tool call' }), output('decline')]);
  assert.equal(result.length, 3);
  assert.deepEqual(result.map(entry => entry.status), ['success', 'failed', 'failed'],
    'WITNESS authoritative MCP success isError and Err determine outcomes');
  for (const item of result) {
    assert.equal(item.source, 'codex');
    assert.equal(item.kind, 'codex-mcp');
    assert.equal(item.tool, 'CodexMCP', 'WITNESS Codex MCP identity never becomes a Claude MCP permission');
    assert.equal(item.command, 'call');
    assert.equal(item.mcpServer, 'Fixture', 'WITNESS exact MCP server and tool case is retained');
    assert.equal(item.mcpTool, 'Exact.Tool', 'WITNESS exact MCP server and tool case is retained');
    assert.equal(item.session, 'fixture-session');
    assert.equal(item.claudePermission, undefined);
    assert.equal(item.arguments, undefined, 'WITNESS raw MCP arguments and response content never leave the parser');
    assert.equal(item.result, undefined);
    assert.equal(item.content, undefined);
    assert.equal(item._callOffset, item._resultOffset);
    assert.equal(item._callEnd, item._resultEnd);
  }
  assert.equal(JSON.stringify(result).includes(secret), false,
    'WITNESS raw MCP arguments and response content never leave the parser');
  assert.equal(Object.keys(result[0]).includes('_callOffset'), false);
});

test('Codex MCP missing or malformed outcome stays unknown despite success-shaped output', () => {
  const outcomes = [undefined, {}, { Ok: {} }, { Ok: { isError: 'false' } }, { Ok: { isError: 0 } },
    { Ok: { content: [{ type: 'text', text: 'Exit code: 0' }] } }, { Ok: { isError: false }, unexpected: true }];
  for (const [index, value] of outcomes.entries()) {
    const records = [meta(), call('unknown-' + index), output('unknown-' + index), end('unknown-' + index, value)];
    const result = parse(records);
    assert.equal(result.length, 1);
    assert.equal(result[0].status, 'unknown', 'WITNESS missing authoritative MCP outcome cannot earn success');
  }
  assert.deepEqual(parse([meta(), call('incomplete'), output('incomplete')]), [],
    'an unfinished function call cannot invent authoritative MCP server and tool identity');
  assert.equal(parse([end('both', { ...ok(false), Err: 'transport failure' })])[0].status, 'failed');
});

test('Codex MCP parser refuses nested spoofed end events and malformed authority fields', () => {
  const valid = end('call', ok());
  for (const record of [
    { type: 'response_item', payload: valid.payload },
    { type: 'event_msg', payload: { type: 'message', content: valid.payload } },
    { type: 'event_msg', payload: { type: 'mcp_tool_call_end', result: ok() } },
    end('', ok()), end(12, ok()), end('call', ok(), '', 'tool'), end('call', ok(), 'server', 'two words'),
    end('call', ok(), 'server', { name: 'tool' }), end('call', ok(), '../server', 'tool'),
    output('call', { result: ok(), payload: valid.payload }),
  ]) {
    assert.deepEqual(parse([meta(), record]), [], 'WITNESS only direct valid MCP completion events confer identity');
  }
  assert.equal(parse([valid]).length, 1);
});

test('Codex MCP completion dedupe is session scoped and conflicting identities withhold success', () => {
  const result = parse([meta('one'), end('same-call', ok()), end('same-call', ok()),
    end('another-call', ok()), meta('two'), end('same-call', ok())]);
  assert.equal(result.length, 3, 'WITNESS duplicate completions count once and separate sessions remain distinct');
  assert.equal(new Set(result.map(item => item.id)).size, 3);
  const failed = parse([end('same-call', ok()), end('same-call', ok(true)), end('same-call', ok())]);
  assert.equal(failed.length, 1);
  assert.equal(failed[0].status, 'failed', 'WITNESS a later success cannot erase an MCP failure');
  for (const [server, tool] of [['Other', 'Exact.Tool'], ['Fixture', 'Other'], ['Fixture', 'exact.tool']]) {
    const collision = parse([end('same-call', ok()), end('same-call', ok(), server, tool), end('same-call', ok())]);
    assert.equal(collision.length, 1);
    assert.equal(collision[0].status, 'unknown', 'WITNESS conflicting exact MCP identities cannot earn success');
  }
});

test('MCP tools named like built-in shell tools never produce shell or Claude observations', () => {
  const records = [meta()];
  for (const name of ['shell_command', 'functions.shell_command', 'exec_command', 'functions.exec_command']) {
    records.push(call(name, name), end(name, ok(), 'Fixture', name), output(name));
  }
  records.push({ type: 'response_item', payload: { type: 'custom_tool_call', namespace: 'mcp__Fixture', name: 'exec',
    call_id: 'custom', input: 'await tools.exec_command({cmd:"git status"})' } },
    end('custom', ok(), 'Fixture', 'exec'),
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'custom', output: 'Exit code: 0' } });
  const observations = parse(records);
  assert.equal(observations.length, 5, 'WITNESS MCP namespaces cannot manufacture extra shell observations');
  assert.ok(observations.every(item => item.kind === 'codex-mcp'));
  const shell = call('actual-shell', 'shell_command', 'functions');
  const ordinary = parse([meta(), shell, output('actual-shell')]);
  assert.equal(ordinary.length, 1);
  assert.equal(ordinary[0].tool, 'PowerShell');
  assert.equal(ordinary[0].status, 'success');
});

test('Codex append scanning sees self-contained MCP completions once without storing sensitive cursor data', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'rollout.jsonl');
  fs.writeFileSync(file, jsonl([meta(), call('later')]));
  const first = scanHistoryFiles({ codexRoots: [root], claudeRoots: [], overlapBytes: 48 });
  assert.equal(first.observations.length, 0);
  const cursors = JSON.parse(JSON.stringify(first.cursors));
  fs.appendFileSync(file, jsonl([end('later', ok()), output('later')]));
  const second = scanHistoryFiles({ codexRoots: [root], claudeRoots: [], cursors, overlapBytes: 48 });
  assert.equal(second.observations.length, 1, 'WITNESS appended authoritative MCP completion is ingested');
  assert.equal(second.observations[0].status, 'success');
  assert.equal(second.observations[0].session, 'fixture-session');
  assert.equal(JSON.stringify(second.cursors).includes(secret), false);
  const unchanged = scanHistoryFiles({ codexRoots: [root], claudeRoots: [], cursors: second.cursors, overlapBytes: 48 });
  assert.equal(unchanged.observations.length, 0, 'WITNESS unchanged Codex transcripts are not re-observed');
  const full = scanHistoryFiles({ codexRoots: [root], claudeRoots: [] });
  assert.equal(full.observations[0].id, second.observations[0].id);
});
