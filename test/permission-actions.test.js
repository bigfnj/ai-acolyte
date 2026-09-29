'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createPermissionActions } = require('../vscode-extension/permissionActions');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

test('optimization waits for Claude before opening the existing Codex review', async () => {
  const claude = deferred();
  const calls = [];
  const actions = createPermissionActions({
    runClaude: async () => { calls.push('claude-start'); await claude.promise; calls.push('claude-end'); },
    reviewCodex: () => { calls.push('codex-review'); },
  });
  const operation = actions.optimize();
  await Promise.resolve();
  assert.deepEqual(calls, ['claude-start'], 'WITNESS ordering: no Codex review before Claude settles');
  claude.resolve();
  assert.equal(await operation, undefined, 'completion makes no claim about policy writes');
  assert.deepEqual(calls, ['claude-start', 'claude-end', 'codex-review'], 'WITNESS both existing actions execute in order');
});

test('repeated and reentrant clicks share one operation until Codex review closes', async () => {
  const review = deferred();
  let claudeCalls = 0;
  let codexCalls = 0;
  let reentrant;
  const actions = createPermissionActions({
    runClaude: () => { claudeCalls++; reentrant = actions.optimize(); },
    reviewCodex: () => { codexCalls++; return review.promise; },
  });
  const first = actions.optimize();
  assert.equal(actions.optimize(), first, 'WITNESS repeated clicks share the active operation');
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(reentrant, first, 'WITNESS callback reentry cannot start another action');
  assert.equal(actions.optimize(), first, 'WITNESS review remains part of the active operation');
  assert.equal(claudeCalls, 1);
  assert.equal(codexCalls, 1);
  review.resolve();
  await first;
  const next = actions.optimize();
  assert.notEqual(next, first, 'WITNESS completion releases the operation for another click');
  await next;
  assert.equal(claudeCalls, 2);
  assert.equal(codexCalls, 2);
});

test('cancelled Codex review completes normally and permits a later review', async () => {
  const choice = deferred();
  const calls = [];
  const actions = createPermissionActions({
    runClaude: () => { calls.push('claude'); },
    reviewCodex: () => { calls.push('review'); return choice.promise; },
  });
  const first = actions.optimize();
  choice.resolve(undefined);
  assert.equal(await first, undefined, 'WITNESS Cancel is not reported as a failed write');
  await actions.optimize();
  assert.deepEqual(calls, ['claude', 'review', 'claude', 'review'], 'WITNESS Cancel releases the next attempt');
});

test('optimization stays pending while the Codex review is open', async () => {
  const review = deferred();
  let settled = false;
  const calls = [];
  const actions = createPermissionActions({
    runClaude: () => { calls.push('claude'); },
    reviewCodex: () => { calls.push('review'); return review.promise; },
  });
  const first = actions.optimize();
  first.then(() => { settled = true; });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(calls, ['claude', 'review']);
  assert.equal(settled, false, 'WITNESS an open review keeps optimization pending');
  assert.equal(actions.optimize(), first, 'WITNESS another click cannot open a second review');
  review.resolve();
  await first;
});

test('a thrown Claude action propagates, withholds Codex and releases retry', async () => {
  const failure = new Error('Claude action failed');
  const calls = [];
  let fail = true;
  const actions = createPermissionActions({
    runClaude: () => { calls.push('claude'); if (fail) throw failure; },
    reviewCodex: () => { calls.push('review'); },
  });
  await assert.rejects(actions.optimize(), error => error === failure, 'WITNESS Claude error reaches the caller unchanged');
  assert.deepEqual(calls, ['claude'], 'WITNESS Claude failure does not launch Codex review');
  fail = false;
  await actions.optimize();
  assert.deepEqual(calls, ['claude', 'claude', 'review'], 'WITNESS failure releases a later attempt');
});

test('an asynchronous Codex review error propagates without replaying Claude', async () => {
  const review = deferred();
  const failure = new Error('Codex review failed');
  const calls = [];
  let fail = true;
  const actions = createPermissionActions({
    runClaude: () => { calls.push('claude'); },
    reviewCodex: () => { calls.push('review'); return fail ? review.promise : undefined; },
  });
  const first = actions.optimize();
  const rejected = assert.rejects(first, error => error === failure, 'WITNESS asynchronous review error reaches caller');
  review.reject(failure);
  await rejected;
  assert.deepEqual(calls, ['claude', 'review'], 'WITNESS no rollback or automatic replay after review failure');
  fail = false;
  await actions.optimize();
  assert.deepEqual(calls, ['claude', 'review', 'claude', 'review']);
});

test('inactive or disposed coordinators do not begin queued actions', async () => {
  const calls = [];
  let active = false;
  const actions = createPermissionActions({
    runClaude: () => { calls.push('claude'); },
    reviewCodex: () => { calls.push('review'); },
    isActive: () => active,
  });
  await actions.optimize();
  assert.deepEqual(calls, [], 'WITNESS inactive extension cannot start optimization');
  active = true;
  const queued = actions.optimize();
  actions.dispose();
  await queued;
  await actions.optimize();
  assert.deepEqual(calls, [], 'WITNESS disposal stops queued and future actions');
});

test('deactivation while Claude runs withholds the not-yet-started Codex review', async () => {
  const claude = deferred();
  const calls = [];
  let active = true;
  const actions = createPermissionActions({
    runClaude: () => { calls.push('claude'); return claude.promise; },
    reviewCodex: () => { calls.push('review'); },
    isActive: () => active,
  });
  const pending = actions.optimize();
  await Promise.resolve();
  active = false;
  claude.resolve();
  await pending;
  assert.deepEqual(calls, ['claude'], 'WITNESS active state is rechecked across the await');
  active = true;
  await actions.optimize();
  assert.deepEqual(calls, ['claude', 'claude', 'review']);
});

test('disposal while Claude runs prevents review even if the host active callback stays true', async () => {
  const claude = deferred();
  const calls = [];
  const actions = createPermissionActions({
    runClaude: () => { calls.push('claude'); return claude.promise; },
    reviewCodex: () => { calls.push('review'); },
  });
  const pending = actions.optimize();
  await Promise.resolve();
  actions.dispose();
  claude.resolve();
  await pending;
  await actions.optimize();
  assert.deepEqual(calls, ['claude'], 'WITNESS disposed coordinator never starts its remaining action');
});
