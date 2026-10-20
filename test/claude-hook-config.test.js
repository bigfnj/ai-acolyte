'use strict';

// The pure planner for the MEMORY.md guard's settings.json entry (src/claude-hook-config.js):
// what it writes, what it calls ours, and that it adds, repairs and removes our handler and
// touches nothing else. Every hook below that is not ours is synthetic.

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const {
  memoryGuardScriptPath, memoryGuardDefinition, inspectMemoryGuard, planMemoryGuard,
} = require('../src/claude-hook-config');

const HOME = path.resolve('fixture home', 'user');
const NODE = path.resolve('fixture tools', 'node', process.platform === 'win32' ? 'node.exe' : 'node');
const OPTIONS = { home: HOME, nodeExecutable: NODE };
const spelled = (file) => (process.platform === 'win32' ? file.replace(/\\/g, '/') : file);

const FOREIGN_PRE = { matcher: 'Bash', hooks: [{ type: 'command', command: 'node audit.js', timeout: 5 }] };
const FOREIGN_POST = [{ matcher: 'Bash|PowerShell', hooks: [{ type: 'command', command: 'node "C:/x/bin/wildcard-perms"', async: true }] }];
const SETTINGS = { model: 'opus', permissions: { allow: ['Bash(git *)'], deny: ['Bash(rm -rf *)'] },
  hooks: { PreToolUse: [FOREIGN_PRE], PostToolUse: FOREIGN_POST } };

test('the definition is one synchronous command hook on Write|Edit|MultiEdit, quoted, with forward slashes on Windows', () => {
  const definition = memoryGuardDefinition(OPTIONS);
  const script = memoryGuardScriptPath(HOME);
  assert.equal(script, path.join(HOME, '.claude', 'wildcarding', 'memory-index-guard.js'));
  assert.deepEqual(definition, { matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command',
    command: `"${spelled(NODE)}" "${spelled(script)}"`, timeout: 10 }] });
  assert.equal('async' in definition.hooks[0], false, 'an async hook cannot block a tool call');
  assert.equal('if' in definition.hooks[0], false, 'no `if` filter until its Write semantics are verified');
  if (process.platform === 'win32') assert.doesNotMatch(definition.hooks[0].command, /\\/);
});

test('the definition refuses a relative node and any path a shell would rewrite', () => {
  assert.throws(() => memoryGuardDefinition({ home: HOME, nodeExecutable: 'node' }), /absolute path to node/);
  assert.throws(() => memoryGuardDefinition({ home: HOME }), /absolute path to node/);
  for (const bad of ['a"b', 'a$HOME', 'a`id`']) {
    assert.throws(() => memoryGuardDefinition({ home: path.resolve(bad), nodeExecutable: NODE }), /a shell would rewrite/);
    assert.throws(() => memoryGuardDefinition({ home: HOME, nodeExecutable: path.resolve(bad, 'node') }), /a shell would rewrite/);
  }
});

test('inspect reads missing, configured, outdated, foreign and unsupported', () => {
  const ours = memoryGuardDefinition(OPTIONS);
  assert.equal(inspectMemoryGuard({}, OPTIONS).status, 'missing');
  assert.equal(inspectMemoryGuard(SETTINGS, OPTIONS).status, 'missing');
  const configured = { ...SETTINGS, hooks: { ...SETTINGS.hooks, PreToolUse: [FOREIGN_PRE, ours] } };
  assert.equal(inspectMemoryGuard(configured, OPTIONS).status, 'configured');
  // Status reads an install it did not make: the node comes from our own command.
  const read = inspectMemoryGuard(configured, { home: HOME });
  assert.equal(read.status, 'configured');
  assert.equal(read.node, spelled(NODE));

  const variants = [
    { ...ours, hooks: [{ ...ours.hooks[0], timeout: 99 }] },
    { ...ours, hooks: [{ ...ours.hooks[0], async: true }] },
    { ...ours, matcher: 'Write' },
  ];
  for (const variant of variants) {
    const settings = { hooks: { PreToolUse: [variant] } };
    assert.equal(inspectMemoryGuard(settings, OPTIONS).status, 'outdated', JSON.stringify(variant));
  }
  const otherNode = path.resolve('elsewhere', 'node.exe');
  assert.equal(inspectMemoryGuard({ hooks: { PreToolUse: [ours] } }, { home: HOME, nodeExecutable: otherNode }).status, 'outdated',
    'ours, but run by another node than the one being installed');
  assert.equal(inspectMemoryGuard({ hooks: { PreToolUse: [ours, ours] } }, OPTIONS).status, 'outdated', 'two of ours');

  const foreignGuard = { matcher: 'Write', hooks: [{ type: 'command',
    command: `node "${spelled(path.resolve('a checkout', 'src', 'memory-index-guard.js'))}"` }] };
  const foreign = inspectMemoryGuard({ hooks: { PreToolUse: [foreignGuard] } }, OPTIONS);
  assert.equal(foreign.status, 'foreign');
  assert.match(foreign.reason, /a command this tool did not write/);

  for (const shape of [[], 'x', { PreToolUse: {} }, { PreToolUse: [{}] }, { PreToolUse: [{ hooks: ['x'] }] }]) {
    assert.equal(inspectMemoryGuard({ hooks: shape }, OPTIONS).status, 'unsupported', JSON.stringify(shape));
  }
  assert.equal(inspectMemoryGuard(null, OPTIONS).status, 'unsupported');
});

// Ownership is the exact stable path as a whole token. A backup beside it, or a path that only
// starts with ours, is not ours, and the backslash spelling of ours on Windows still is.
// MUTATION: drop the trailing lookahead in namesOurScript and the `.bak` handler reads as ours,
// so `off` would delete it.
test('ownership is our stable path, as a whole path', () => {
  const script = spelled(memoryGuardScriptPath(HOME));
  const handler = (command) => ({ hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command }] }] } });
  assert.equal(inspectMemoryGuard(handler(`node "${script}.bak"`), OPTIONS).status, 'missing');
  assert.equal(inspectMemoryGuard(handler(`node "${script}x"`), OPTIONS).status, 'missing');
  assert.equal(inspectMemoryGuard(handler(`node "/prefix${script}"`), OPTIONS).status, 'foreign',
    'a path that only ends in ours is another guard, not ours');
  assert.equal(inspectMemoryGuard(handler(`node "${script}"`), OPTIONS).status, 'outdated', 'ours with another command');
  if (process.platform === 'win32') {
    const backslashed = memoryGuardScriptPath(HOME).toUpperCase().replace('MEMORY-INDEX-GUARD.JS', 'memory-index-guard.js');
    assert.equal(inspectMemoryGuard(handler(`node "${backslashed}"`), OPTIONS).status, 'outdated');
  }
});

// The user's own wrapper around our copy is theirs (audit 2026-10-20): ownership by path alone
// let `on` replace it and `off` delete it. A node and our copy, and nothing else, is ours.
// MUTATION: go back to "names our path anywhere in the command" and the wrapper reads as ours,
// so on rewrites it and off removes it.
test('a command that wraps our copy, or passes it more arguments, is foreign and left alone', () => {
  const script = spelled(memoryGuardScriptPath(HOME));
  const handler = (command) => ({ hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', hooks: [{ type: 'command', command }] }] } });
  for (const command of [`timeout 5 node "${script}"`, `"${spelled(NODE)}" "${script}" --verbose`, `sh -c 'node "${script}"'`,
    `bash "${script}"`]) {
    const settings = handler(command);
    assert.equal(inspectMemoryGuard(settings, OPTIONS).status, 'foreign', command);
    assert.throws(() => planMemoryGuard(settings, true, OPTIONS), /refusing to add the MEMORY\.md guard/, command);
    const off = planMemoryGuard(settings, false, OPTIONS);
    assert.equal(off.changed, false, `off leaves ${command} alone`);
    assert.equal(off.settings, settings);
  }
  for (const command of [`"${spelled(NODE)}" "${script}"`, `node "${script}"`, ` '${spelled(NODE)}'  '${script}' `]) {
    assert.notEqual(inspectMemoryGuard(handler(command), OPTIONS).status, 'foreign', `ours: ${command}`);
    assert.equal(planMemoryGuard(planMemoryGuard(handler(command), true, OPTIONS).settings, false, OPTIONS).settings.hooks, undefined,
      `on repairs ${command} and off removes it`);
  }
});

test('on adds one group and keeps every other key, event and group as it was', () => {
  const plan = planMemoryGuard(SETTINGS, true, OPTIONS);
  assert.equal(plan.changed, true);
  assert.equal(plan.status, 'configured');
  assert.deepEqual(plan.settings.hooks.PreToolUse, [FOREIGN_PRE, memoryGuardDefinition(OPTIONS)]);
  assert.deepEqual(plan.settings.hooks.PostToolUse, FOREIGN_POST);
  assert.deepEqual(Object.keys(plan.settings), Object.keys(SETTINGS), 'key order is kept');
  assert.deepEqual({ ...plan.settings, hooks: undefined }, { ...SETTINGS, hooks: undefined });
  assert.deepEqual(SETTINGS.hooks.PreToolUse, [FOREIGN_PRE], 'the input object is not mutated');
  const again = planMemoryGuard(plan.settings, true, OPTIONS);
  assert.equal(again.changed, false, 'on is idempotent');
  assert.equal(again.settings, plan.settings);
  const fresh = planMemoryGuard({}, true, OPTIONS);
  assert.deepEqual(fresh.settings, { hooks: { PreToolUse: [memoryGuardDefinition(OPTIONS)] } });
});

test('on repairs an outdated handler in place of adding a second one', () => {
  const stale = { matcher: 'Write|Edit|MultiEdit', hooks: [{ ...memoryGuardDefinition(OPTIONS).hooks[0], timeout: 99 }] };
  const shared = { matcher: 'Edit', hooks: [FOREIGN_PRE.hooks[0], stale.hooks[0]] };
  const plan = planMemoryGuard({ hooks: { PreToolUse: [stale, shared, FOREIGN_PRE] } }, true, OPTIONS);
  assert.deepEqual(plan.settings.hooks.PreToolUse, [
    { matcher: 'Edit', hooks: [FOREIGN_PRE.hooks[0]] }, FOREIGN_PRE, memoryGuardDefinition(OPTIONS),
  ], 'our group was emptied and dropped, the shared group kept its other handler, and one fresh group was added');
  assert.equal(inspectMemoryGuard(plan.settings, OPTIONS).status, 'configured');
});

test('on refuses a foreign guard and an unreadable hooks shape, and changes nothing', () => {
  const foreign = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [{ type: 'command', command: 'node /x/memory-index-guard.js' }] }] } };
  assert.throws(() => planMemoryGuard(foreign, true, OPTIONS), /refusing to add the MEMORY\.md guard: another hook/);
  assert.throws(() => planMemoryGuard({ hooks: [] }, true, OPTIONS), /refusing to change the MEMORY\.md guard/);
  assert.throws(() => planMemoryGuard({ hooks: [] }, false, OPTIONS), /refusing to change the MEMORY\.md guard/);
  assert.throws(() => planMemoryGuard({}, 'yes', OPTIONS), /boolean/);
});

// MUTATION: make withoutOurs drop every group it touched (ignore `plain`) and the metadata
// group below disappears; make it keep empty groups and the round trip below is not exact.
test('off removes only our handler, drops only an emptied group of ours, and round-trips exactly', () => {
  const on = planMemoryGuard(SETTINGS, true, OPTIONS).settings;
  const off = planMemoryGuard(on, false, OPTIONS);
  assert.equal(off.changed, true);
  assert.equal(off.status, 'missing');
  assert.deepEqual(off.settings, SETTINGS);
  assert.equal(JSON.stringify(off.settings), JSON.stringify(SETTINGS), 'key order too');
  const onlyOurs = planMemoryGuard({}, true, OPTIONS).settings;
  assert.deepEqual(planMemoryGuard(onlyOurs, false, OPTIONS).settings, {},
    'an emptied PreToolUse and hooks object go when they held only ours');
  const ours = memoryGuardDefinition(OPTIONS).hooks[0];
  const withMetadata = { hooks: { PreToolUse: [{ matcher: 'Write|Edit|MultiEdit', description: 'mine', hooks: [ours] }] } };
  assert.deepEqual(planMemoryGuard(withMetadata, false, OPTIONS).settings.hooks.PreToolUse,
    [{ matcher: 'Write|Edit|MultiEdit', description: 'mine', hooks: [] }], 'a group carrying anything else survives');
  const missing = planMemoryGuard(SETTINGS, false, OPTIONS);
  assert.equal(missing.changed, false);
  assert.equal(missing.settings, SETTINGS);
  // Off with a foreign guard present: ours goes, the foreign one stays, and off does not refuse.
  const foreignHandler = { type: 'command', command: 'node /x/memory-index-guard.js' };
  const both = { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [foreignHandler] }, memoryGuardDefinition(OPTIONS)] } };
  const offBoth = planMemoryGuard(both, false, OPTIONS);
  assert.deepEqual(offBoth.settings, { hooks: { PreToolUse: [{ matcher: 'Write', hooks: [foreignHandler] }] } });
  assert.equal(offBoth.status, 'foreign');
});
