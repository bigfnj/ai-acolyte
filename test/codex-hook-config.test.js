'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { codexStopHookDefinition, inspectCodexStopHook, mergeCodexStopHook } = require('../src/codex-hook-config');

const options = { scriptPath: path.resolve('fixture owned', 'codex-stop-hook.js') };

test('hook config merges only its exact Stop definition and keeps foreign events metadata and shared groups', () => {
  const foreign = { type: 'command', command: 'node foreign.js', timeout: 17 };
  const before = { description: 'user café', vendor: { enabled: true }, hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [foreign] }], Stop: [{ owner: 'user', hooks: [foreign] }],
  } };
  const input = JSON.stringify(before, null, 2).replace(/\n/g, '\r\n') + '\r\n';
  const enabled = mergeCodexStopHook(input, true, options);
  assert.equal(enabled.changed, true);
  const data = JSON.parse(enabled.text);
  assert.equal(data.hooks.Stop.length, 2);
  assert.deepEqual(data.hooks.Stop[0], before.hooks.Stop[0], 'WITNESS enabling keeps every foreign Stop handler and metadata');
  assert.deepEqual(data.hooks.PreToolUse, before.hooks.PreToolUse);
  assert.deepEqual(data.vendor, before.vendor);
  assert.ok(enabled.text.includes('\r\n'));
  assert.equal(mergeCodexStopHook(enabled.text, true, options).text, enabled.text, 'repeat enable preserves exact bytes');
  const disabled = mergeCodexStopHook(enabled.text, false, options);
  assert.deepEqual(JSON.parse(disabled.text), before, 'WITNESS disabling removes only the exact owned definition');
  const shared = { hooks: { Stop: [{ owner: 'keep this', hooks: [foreign, ...codexStopHookDefinition(options).hooks] }] } };
  assert.deepEqual(JSON.parse(mergeCodexStopHook(JSON.stringify(shared), false, options).text),
    { hooks: { Stop: [{ owner: 'keep this', hooks: [foreign] }] } });
  const metadataOnly = { hooks: { Stop: [{ owner: 'keep even when empty', hooks: codexStopHookDefinition(options).hooks }] } };
  assert.deepEqual(JSON.parse(mergeCodexStopHook(JSON.stringify(metadataOnly), false, options).text).hooks.Stop,
    [{ owner: 'keep even when empty', hooks: [] }]);
});

test('hook config never equates configuration with reviewed trust and treats missing files explicitly', () => {
  const missing = inspectCodexStopHook(null, options);
  assert.equal(missing.status, 'missing');
  assert.equal(missing.configured, false);
  assert.equal(mergeCodexStopHook(null, false, options).changed, false);
  const enabled = mergeCodexStopHook(null, true, options);
  assert.equal(enabled.status, 'configured');
  assert.equal(enabled.trust, 'not-verified', 'WITNESS writing hooks.json never grants hook trust');
  assert.equal(enabled.reviewRequired, true);
  assert.deepEqual(Object.keys(JSON.parse(enabled.text)), ['hooks'], 'no private trust or ownership metadata is invented');
  const unreadable = inspectCodexStopHook(null, { ...options, readError: new Error('EACCES fixture') });
  assert.equal(unreadable.status, 'unreadable');
  assert.equal(unreadable.writable, false);
  assert.throws(() => mergeCodexStopHook(null, true, { ...options, readError: new Error('EACCES fixture') }), /EACCES/);
});

test('hook config refuses malformed ambiguous and changed definitions rather than deleting or duplicating them', () => {
  const expected = codexStopHookDefinition(options);
  for (const text of ['', '{bad', '[]', '{"hooks":[]}', '{"hooks":{"Stop":{}}}', '{"hooks":{"Stop":[{}]}}']) {
    assert.equal(inspectCodexStopHook(text, options).writable, false, 'WITNESS malformed hooks remain untouched');
    assert.throws(() => mergeCodexStopHook(text, true, options), /Refusing/);
  }
  const variants = [
    { ...expected.hooks[0], command: 'node changed.js' },
    { ...expected.hooks[0], timeout: 99 },
    { ...expected.hooks[0], async: true },
    { ...expected.hooks[0], statusMessage: 'changed title' },
  ];
  const texts = variants.map((handler) => JSON.stringify({ hooks: { Stop: [{ hooks: [handler] }] } }));
  texts.push(JSON.stringify({ hooks: { Stop: [expected, expected] } }));
  for (const text of texts) {
    const state = inspectCodexStopHook(text, options);
    assert.equal(state.status, 'changed-definition', 'WITNESS changed or duplicate ownership is explicit');
    for (const enabled of [true, false]) assert.throws(() => mergeCodexStopHook(text, enabled, options), /Refusing/,
      'WITNESS ambiguous ownership never authorizes replacement or deletion');
  }
});

test('hook command quotes paths for POSIX and Windows without executing path content', () => {
  const scriptPath = path.resolve("space dir", "owner's $probe;literal.js");
  const definition = codexStopHookDefinition({ scriptPath, nodeExecutable: "node's executable" });
  const handler = definition.hooks[0];
  assert.ok(handler.command.startsWith("'node'\"'\"'s executable' "), 'WITNESS POSIX quoting protects apostrophes');
  assert.ok(handler.commandWindows.startsWith("& 'node''s executable' "), 'WITNESS Windows quoting invokes quoted executable with call operator');
  assert.ok(handler.commandWindows.includes("owner''s $probe;literal.js'"));
  assert.equal(Object.hasOwn(handler, 'async'), false, 'Codex 0.145 skips async hooks');
  assert.equal(handler.type, 'command');
  assert.equal(codexStopHookDefinition().hooks[0].command.includes('codex-stop-hook.js'), true);
  assert.throws(() => codexStopHookDefinition({ scriptPath: 'relative.js' }), /absolute path/);
  assert.throws(() => codexStopHookDefinition({ nodeExecutable: 'node\nmalicious' }), /control/);
});
