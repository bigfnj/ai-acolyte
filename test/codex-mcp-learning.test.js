'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { aggregateObservations } = require('../src/auto-learn');
const { parseCodexJsonl } = require('../src/history-adapters');
const { renderClaudePermissions, renderCodexRules } = require('../src/policy-exporters');

const observation = (server = 'Fixture', tool = 'Exact.Tool', status = 'success') => ({
  kind: 'codex-mcp', source: 'codex', tool: 'CodexMCP', command: 'call',
  mcpServer: server, mcpTool: tool, status,
});
const aggregate = (observations, threshold = 1) => aggregateObservations(observations, { threshold });

test('Codex MCP learned families retain exact case and disambiguate server tool delimiters', () => {
  const pairs = [['Fixture', 'Tool'], ['fixture', 'Tool'], ['Fixture', 'tool'],
    ['A__B', 'C'], ['A', 'B__C'], ['Fixture.exe', 'Tool']];
  const candidates = aggregate(pairs.flatMap(([server, tool]) => [observation(server, tool), observation(server, tool)]));
  assert.equal(candidates.length, pairs.length, 'WITNESS each exact MCP server/tool tuple remains distinct');
  for (const [server, tool] of pairs) {
    const candidate = candidates.find(item => item.key === `codex-mcp:${JSON.stringify([server, tool])}`);
    assert.ok(candidate, 'WITNESS case-sensitive tuple key is exact');
    assert.deepEqual(candidate.prefix, [server, tool]);
    assert.equal(candidate.root, server);
    assert.equal(candidate.kind, 'tool');
    assert.equal(candidate.tool, 'CodexMCP');
    assert.equal(candidate.counts.success, 2);
    assert.deepEqual(candidate.sources, ['codex']);
  }
});

test('Codex MCP candidates are opaque review-only and cannot become shell or Claude grants', () => {
  const candidates = aggregate(Array.from({ length: 8 }, () => observation()), 3);
  const candidate = candidates[0];
  assert.equal(candidate.autoSafe, false);
  assert.equal(candidate.baseAutoSafe, false, 'WITNESS opaque MCP families never acquire deterministic auto-safe eligibility');
  assert.equal(candidate.disposition, 'review');
  assert.equal(candidate.meetsThreshold, true);
  assert.equal(candidate.claudePermission, null, 'WITNESS Codex MCP families carry no Claude permission');
  assert.deepEqual(candidate.permissions, []);
  assert.deepEqual(renderClaudePermissions(candidates, { includeReviewed: true }), [],
    'WITNESS reviewed Codex MCP candidates never export a Claude grant');
  assert.doesNotMatch(renderCodexRules(candidates, { includeReviewed: true }), /prefix_rule\s*\(/,
    'WITNESS reviewed Codex MCP candidates never export an argv rule');
  assert.deepEqual(renderClaudePermissions(candidates), []);
  assert.equal(candidate.risk, 'unknown');
  assert.deepEqual(candidate.reasons, ['codex-mcp-tool', 'opaque-capability']);
});

test('Codex MCP aggregation counts only normalized authoritative statuses and discards raw fields', () => {
  const sentinel = 'DO_NOT_PERSIST_RAW_MCP_CONTENT';
  const input = [
    { ...observation(), arguments: { secret: sentinel }, output: sentinel, command: sentinel, success: false },
    { ...observation('Fixture', 'Exact.Tool', 'failed'), success: true },
    { ...observation('Fixture', 'Exact.Tool', 'unknown'), success: true, isError: false },
    { ...observation('Fixture', 'Exact.Tool', 'completed'), success: true },
  ];
  const candidate = aggregate(input)[0];
  assert.deepEqual(candidate.counts, { success: 1, failed: 1, unknown: 2, total: 4 },
    'WITNESS only explicit parser statuses count as Codex MCP outcomes');
  assert.equal(JSON.stringify(candidate).includes(sentinel), false,
    'WITNESS aggregation retains no raw MCP arguments or output');
  assert.deepEqual(candidate.examples, ['Fixture Exact.Tool']);
});

test('Codex MCP family creation rejects malformed identity or foreign source fields', () => {
  for (const changes of [{ source: 'claude' }, { tool: 'Bash' }, { mcpServer: '' }, { mcpTool: '../tool' },
    { mcpServer: ['Fixture'] }, { mcpTool: 'two words' }, { mcpTool: 'x'.repeat(129) }]) {
    assert.deepEqual(aggregate([{ ...observation(), ...changes }]), [],
      'WITNESS only the dedicated Codex MCP observation shape can form its candidate');
  }
  const normal = aggregate([{ kind: 'tool', source: 'claude', tool: 'mcp__Fixture__Exact.Tool', command: 'call', status: 'success' }]);
  assert.equal(normal[0].key, 'mcp:fixture__exact.tool');
  assert.equal(normal[0].claudePermission, 'mcp__Fixture__Exact.Tool');
});

test('measured Codex MCP completion shapes ingest into isolated candidates with honest failure and unknown counts', () => {
  const outcomes = [{ Ok: { isError: false, content: [{ type: 'text', text: 'same inert content' }] } },
    { Ok: { isError: true, content: [{ type: 'text', text: 'same inert content' }] } },
    { Err: 'user rejected MCP tool call' }, { Ok: { content: [{ type: 'text', text: 'Script completed' }] } }];
  const records = [{ type: 'session_meta', payload: { id: 'actual-shape-fixture' } }, ...outcomes.map((result, index) => ({
    type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'call_' + index,
      invocation: { server: 'Fixture', tool: 'Exact.Tool', arguments: { private: 'never retained' } }, result },
  }))];
  const observations = parseCodexJsonl(records.map(item => JSON.stringify(item)).join('\n'));
  const candidate = aggregate(observations, 2)[0];
  assert.deepEqual(candidate.counts, { success: 1, failed: 2, unknown: 1, total: 4 },
    'WITNESS authoritative rollout events survive parser-to-candidate ingestion without outcome inflation');
  assert.equal(candidate.disposition, 'observe');
  assert.equal(candidate.autoSafe, false);
  assert.equal(candidate.kind, 'tool');
  assert.equal(JSON.stringify(candidate).includes('never retained'), false);
});
