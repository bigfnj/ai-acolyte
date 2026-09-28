'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createCodexFeaturesUi } = require('../vscode-extension/codexFeaturesUi');

function fixture(inventory = {}) {
  const plan = { id: 'selection-fingerprint', kind: 'project-import',
    source: { path: '/project/.codex/rules/source.rules', text: 'prefix_rule(pattern=["git"], decision="allow")' },
    target: { pattern: ['git'], decision: 'allow', text: 'prefix_rule(pattern=["git"], decision="allow")' },
    dependencies: [{ source: { path: '/project/.codex/rules/restriction.rules' },
      target: { text: 'prefix_rule(pattern=["git","push"], decision="prompt")' } }],
    reviewReason: 'This allow is not auto-safe; explicit review is required.' };
  const seen = { calls: [], dialogs: [], warnings: [], messages: [], refresh: 0 };
  const view = { plans: [plan], destination: { path: '/selected/rules/ai-acolyte-reviewed.rules' }, files: [], skipped: [], ...inventory };
  const window = {
    async showQuickPick(rows, options) { seen.rows = rows; seen.options = options; return rows[0]; },
    async showWarningMessage(...args) { seen.dialogs.push(args); return undefined; },
    showInformationMessage(message) { seen.messages.push(message); },
  };
  const ui = createCodexFeaturesUi({ window }, {
    runRules: async (...args) => { seen.calls.push(args); return args[0] === 'codexApprovalInventory'
      ? view : { changed: true, addedCount: 2 }; },
    refresh: () => { seen.refresh++; },
  });
  return { plan, seen, view, window, ui };
}

test('reviewed Codex UI shows full source, target and restrictions, cancels, then sends only fresh-selection identity', async () => {
  const f = fixture();
  await f.ui.reviewRules('project-import');
  assert.deepEqual(f.seen.calls, [['codexApprovalInventory', 'project-import']], 'WITNESS Cancel never calls the writer');
  const [, modal, action] = f.seen.dialogs[0];
  assert.equal(action, 'Apply change');
  assert.equal(modal.modal, true);
  assert.ok(modal.detail.includes(f.plan.source.path));
  assert.ok(modal.detail.includes(f.plan.source.text));
  assert.ok(modal.detail.includes(f.plan.target.text));
  assert.ok(modal.detail.includes(f.plan.dependencies[0].target.text), 'WITNESS restrictive dependency is part of the review');
  assert.match(modal.detail, /not auto-safe/);
  assert.match(modal.detail, /applies across workspaces/);
  f.window.showWarningMessage = async (...args) => args[2];
  await f.ui.reviewRules('project-import');
  assert.deepEqual(f.seen.calls.at(-1), ['approveCodexRules', { kind: 'project-import', id: f.plan.id }]);
  assert.equal(f.seen.refresh, 1);
  assert.match(f.seen.messages[0], /added 2 reviewed Codex rules/);
});

test('reviewed Codex UI cannot write from a confirmation resolved after disposal', async () => {
  const f = fixture();
  let answer;
  let opened;
  const ready = new Promise((resolve) => { opened = resolve; });
  f.window.showWarningMessage = () => { opened(); return new Promise((resolve) => { answer = resolve; }); };
  const pending = f.ui.reviewRules();
  await ready;
  f.ui.dispose();
  answer('Apply change');
  await pending;
  assert.equal(f.seen.calls.length, 1, 'WITNESS teardown blocks confirmed policy writes');
});

test('reviewed Codex UI keeps unsupported sources read-only and refuses other pending operations', async () => {
  const f = fixture({ plans: [], files: [{ path: '/project/computed.rules', supported: false, reason: 'Computed input' }] });
  await f.ui.reviewRules();
  assert.equal(f.seen.calls.length, 1, 'WITNESS unsupported selection has no writer route');
  assert.equal(f.seen.dialogs.length, 1);
  assert.match(f.seen.dialogs[0][0], /Computed input/);
  f.view.pendingRestore = true;
  await f.ui.reviewRules();
  assert.equal(f.seen.calls.length, 2);
  assert.match(f.seen.dialogs.at(-1)[0], /Restore Codex rules/);
});

test('reviewed Codex UI resumes only after explicit confirmation and does not report a no-op as success', async () => {
  const f = fixture({ pendingApproval: true, plans: [] });
  await f.ui.reviewRules();
  assert.equal(f.seen.calls.length, 1);
  f.window.showWarningMessage = async (...args) => args[2];
  await f.ui.reviewRules();
  assert.deepEqual(f.seen.calls.at(-1), ['approveCodexRules', { resume: true }]);
  assert.equal(f.seen.messages.length, 1);
  const seen = [];
  const bad = createCodexFeaturesUi({ window: {
    showWarningMessage: async (...args) => { seen.push(args); return args[2]; },
    showInformationMessage: () => { throw new Error('false success'); },
  } }, { runRules: async (operation) => operation === 'codexApprovalInventory' ? f.view : { changed: false, addedCount: 0 } });
  await bad.reviewRules();
  assert.match(seen.at(-1)[0], /No Codex rule was added/, 'WITNESS false writer success is visible');
});
