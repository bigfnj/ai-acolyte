'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexMcpReview } = require('../src/codex-mcp-review');
const { createCodexFeaturesUi } = require('../vscode-extension/codexFeaturesUi');

function fixture() {
  const key = 'codex-mcp:["Case.Server","Tool.Name"]';
  const item = { key, kind: 'tool', tool: 'CodexMCP', prefix: ['Case.Server', 'Tool.Name'],
    counts: { success: 3, failed: 1, unknown: 2 }, threshold: 3, sources: ['codex'], claudePermission: null };
  const state = { mode: 'recommend', candidates: { [key]: item } };
  const calls = [];
  const config = {
    assertReady() { calls.push(['assertReady']); },
    inspectPending() { return null; },
    listCodexMcpApprovals() { return []; },
    planCodexMcpApproval(options) { calls.push(['plan', options]); return { supported: true, fingerprint: 'config-version' }; },
    applyCodexMcpApproval(...args) { calls.push(['apply', ...args]); return { changed: true }; },
    restoreCodexMcpApproval(...args) { calls.push(['restore', ...args]); return { changed: true }; },
    finishPending(...args) { calls.push(['recover', ...args]); return { changed: false, cancelled: true }; },
  };
  const review = createCodexMcpReview({ options: { codexHome: '/selected-profile' }, loadState: () => state,
    fingerprint: (value) => JSON.stringify(value.counts), assertRulesReady: (options) => calls.push(['rulesReady', options]), config });
  return { key, item, state, calls, config, review };
}

test('Codex MCP review routes only exact Codex tool identities and never shell or Claude candidates', () => {
  const f = fixture();
  f.state.candidates.shell = { ...f.item, key: 'bash:git status', kind: 'shell' };
  f.state.candidates.claude = { ...f.item, key: 'mcp:case:tool', sources: ['claude'], claudePermission: 'mcp__case__tool' };
  f.state.candidates.forged = { ...f.item, key: 'codex-mcp:["Other","Tool.Name"]' };
  assert.deepEqual(f.review.inventory().candidates.map((item) => item.key), [f.key], 'WITNESS separate exact MCP namespace');
  const planned = f.review.plan({ key: f.key });
  f.review.apply({ key: f.key, expectedCandidateFingerprint: planned.candidate.fingerprint, expectedConfigFingerprint: planned.proposal.fingerprint });
  assert.deepEqual(f.calls.at(-1), ['apply', { server: 'Case.Server', tool: 'Tool.Name', expectedFingerprint: 'config-version' }, { codexHome: '/selected-profile' }]);
});

test('Codex MCP review withholds observe mode, insufficient success and pending evidence without config calls', () => {
  const f = fixture();
  for (const mutate of [() => { f.state.mode = 'observe'; }, () => { f.state.mode = 'recommend'; f.item.counts.success = 2; },
    () => { f.item.counts.success = 3; f.state.codexEvidenceRebuildPending = true; }]) {
    mutate();
    assert.equal(f.review.inventory().candidates[0].eligible, false);
    assert.throws(() => f.review.plan({ key: f.key }), /observe mode|required|rebuilt/);
    assert.equal(f.calls.some((call) => call[0] === 'plan'), false, 'WITNESS no config proposal before evidence is eligible');
  }
});

test('Codex MCP review binds both evidence and config fingerprints and refuses changed evidence', () => {
  const f = fixture();
  const planned = f.review.plan({ key: f.key });
  assert.throws(() => f.review.apply({ key: f.key }), /Review the current/);
  f.item.counts.failed++;
  assert.throws(() => f.review.apply({ key: f.key, expectedCandidateFingerprint: planned.candidate.fingerprint,
    expectedConfigFingerprint: 'config-version' }), /evidence changed/, 'WITNESS stale observed outcomes cannot be confirmed');
  assert.equal(f.calls.some((call) => call[0] === 'apply'), false);
});

test('Codex MCP review checks shared rule journal before grant, undo and config recovery', () => {
  const f = fixture();
  const blocked = createCodexMcpReview({ options: {}, loadState: () => f.state, fingerprint: () => 'fp',
    assertRulesReady: () => { throw new Error('pending shell change'); }, config: f.config });
  assert.throws(() => blocked.plan({ key: f.key }), /pending shell/);
  assert.throws(() => blocked.apply({ key: f.key, expectedCandidateFingerprint: 'fp', expectedConfigFingerprint: 'cfp' }), /pending shell/);
  assert.throws(() => blocked.restore({ receiptId: 'saved' }), /pending shell/);
  assert.throws(() => blocked.recover({ id: 'pending', acceptedHash: 'current' }), /pending shell/);
  assert.equal(f.calls.length, 0, 'WITNESS no MCP operation bypasses the rule journal');
  f.review.recover({ id: 'pending', acceptedHash: 'current' });
  assert.deepEqual(f.calls.at(-2), ['rulesReady', { allowMcpPending: true }]);
});

function uiFixture() {
  const candidate = { key: 'mcp-key', server: 'Case.Server', tool: 'Tool.Name', eligible: true,
    fingerprint: 'evidence', counts: { success: 3, failed: 1, unknown: 0 } };
  const proposal = { supported: true, source: { path: '/selected/config.toml' }, fingerprint: 'config',
    effectiveApprovalMode: 'prompt', explicitApprovalMode: null };
  const view = { candidates: [candidate], receipts: [], pending: null };
  const seen = { calls: [], dialogs: [], messages: [], refresh: 0 };
  const window = {
    async showQuickPick(rows) { return rows[0]; },
    async showWarningMessage(...args) { seen.dialogs.push(args); return undefined; },
    showInformationMessage(message) { seen.messages.push(message); },
  };
  const ui = createCodexFeaturesUi({ window }, { runRules: async (...args) => {
    seen.calls.push(args);
    if (args[0] === 'codexMcpInventory') return view;
    if (args[0] === 'planCodexMcp') return { candidate, proposal };
    return { changed: true };
  }, refresh: () => { seen.refresh++; } });
  return { ui, window, seen, view, candidate, proposal };
}

test('Codex MCP UI reviews capability scope and outcomes, honors cancel, then sends exact fingerprints', async () => {
  const f = uiFixture();
  await f.ui.reviewMcp();
  assert.deepEqual(f.seen.calls.map((call) => call[0]), ['codexMcpInventory', 'planCodexMcp'], 'WITNESS Cancel has no write');
  const [, modal] = f.seen.dialogs[0];
  assert.match(modal.detail, /Case.Server \/ Tool.Name/);
  assert.match(modal.detail, /3 successful, 1 failed/);
  assert.match(modal.detail, /including different arguments/, 'WITNESS full capability grant is explicit');
  assert.match(modal.detail, /not classified as safe/);
  assert.match(modal.detail, /across workspaces/);
  f.window.showWarningMessage = async (...args) => args[2];
  await f.ui.reviewMcp();
  assert.deepEqual(f.seen.calls.at(-1), ['approveCodexMcp', { key: 'mcp-key', expectedCandidateFingerprint: 'evidence', expectedConfigFingerprint: 'config' }]);
  assert.equal(f.seen.refresh, 1);
});

test('Codex MCP UI confirmation resolved after disposal cannot grant a capability', async () => {
  const f = uiFixture();
  let answer, ready;
  const opened = new Promise((resolve) => { ready = resolve; });
  f.window.showWarningMessage = () => { ready(); return new Promise((resolve) => { answer = resolve; }); };
  const pending = f.ui.reviewMcp();
  await opened; f.ui.dispose(); answer('Approve tool'); await pending;
  assert.equal(f.seen.calls.some((call) => call[0] === 'approveCodexMcp'), false, 'WITNESS disposed UI cannot approve');
});

test('Codex MCP UI keeps unsupported configuration read-only and requires confirmation for receipt undo', async () => {
  const f = uiFixture();
  f.proposal.supported = false; f.proposal.reason = 'Plugin server requires another layer';
  await f.ui.reviewMcp();
  assert.match(f.seen.dialogs[0][0], /Plugin server/);
  assert.equal(f.seen.calls.length, 2);
  f.view.candidates = [];
  f.view.receipts = [{ id: 'receipt', server: 'Case.Server', tool: 'Tool.Name', path: '/selected/config.toml',
    undoable: true, beforeApproval: { exists: true, value: 'prompt' } }];
  await f.ui.reviewMcp();
  assert.equal(f.seen.calls.at(-1)[0], 'codexMcpInventory', 'WITNESS cancelled Undo cannot write');
  assert.match(f.seen.dialogs.at(-1)[1].detail, /previous per-tool setting: prompt/);
  f.window.showWarningMessage = async (...args) => args[2];
  await f.ui.reviewMcp();
  assert.deepEqual(f.seen.calls.at(-1), ['undoCodexMcp', { receiptId: 'receipt' }]);
});

test('Codex MCP UI recovery binds accepted current bytes and refuses false no-op success', async () => {
  const f = uiFixture();
  f.view.pending = { id: 'pending', server: 'Case.Server', tool: 'Tool.Name', path: '/selected/config.toml', currentHash: 'accepted-current' };
  await f.ui.reviewMcp();
  assert.equal(f.seen.calls.length, 1);
  f.window.showWarningMessage = async (...args) => args[2];
  await f.ui.reviewMcp();
  assert.deepEqual(f.seen.calls.at(-1), ['recoverCodexMcp', { id: 'pending', acceptedHash: 'accepted-current' }]);
  const messages = [];
  const ui = createCodexFeaturesUi({ window: {
    showWarningMessage: async (...args) => { messages.push(args); return args[2]; },
    showInformationMessage: () => { throw new Error('false success'); },
  } }, { runRules: async (operation) => operation === 'codexMcpInventory' ? f.view : { changed: false } });
  await ui.reviewMcp();
  assert.match(messages.at(-1)[0], /No Codex MCP configuration change was confirmed/);
});

test('Codex MCP UI retains a saved approval visibly when concurrent config changes make Undo read-only', async () => {
  const f = uiFixture();
  f.view.candidates = [];
  f.view.receipts = [{ id: 'receipt', server: 'Case.Server', tool: 'Tool.Name', path: '/selected/config.toml',
    restored: false, undoable: false, reason: 'Configuration changed since this approval.',
    beforeApproval: { exists: true, value: 'prompt' } }];
  let rows;
  f.window.showQuickPick = async (choices) => { rows = choices; return choices[0]; };
  await f.ui.reviewMcp();
  assert.equal(rows.length, 1, 'WITNESS retained receipt cannot vanish when Undo is refused');
  assert.equal(rows[0].description, 'Saved approval needs review');
  assert.match(rows[0].detail, /Configuration changed/);
  assert.match(f.seen.dialogs[0][0], /Configuration changed/);
  assert.deepEqual(f.seen.calls.map((call) => call[0]), ['codexMcpInventory'], 'WITNESS read-only receipt never reaches Undo writer');
});
