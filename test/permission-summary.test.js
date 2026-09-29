'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readCodexPermissionSummary } = require('../src/permission-summary');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-permission-summary-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const codexHome = path.join(home, 'selected-codex');
  const rules = path.join(codexHome, 'rules');
  fs.mkdirSync(rules, { recursive: true });
  const write = (name, content) => {
    const file = path.join(rules, name);
    fs.writeFileSync(file, content);
    return file;
  };
  return { home, codexHome, rules, write, read: (extra = {}) => readCodexPermissionSummary({ home, codexHome, ...extra }) };
}

const rule = (pattern, decision = 'allow') => `prefix_rule(pattern=${JSON.stringify(pattern)}, decision="${decision}")\n`;
const counts = ({ allow, prompt, forbidden, total, complete }) => ({ allow, prompt, forbidden, total, complete });

test('Codex summary counts saved declarations once, including grouped alternatives and restrictive decisions', (t) => {
  const f = fixture(t);
  f.write('first.rules', '# prefix_rule(pattern=["fake"], decision="allow")\n'
    + rule([['git', 'git.exe'], ['status', 'diff']]) + rule(['git', 'status'])
    + rule(['git', 'push'], 'prompt') + rule(['git', 'push', '--force'], 'forbidden'));
  f.write('second.rules', rule(['git', 'status']));
  f.write('ignored.txt', rule(['ignored']));
  const before = fs.readdirSync(f.rules).map((name) => [name, fs.readFileSync(path.join(f.rules, name), 'hex')]);
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 3, prompt: 1, forbidden: 1, total: 5, complete: true },
    'WITNESS each declaration is counted once and prompt/forbidden are never allow approvals');
  assert.equal(summary.files.length, 2);
  assert.deepEqual(summary.allowRules.map(({ pattern }) => pattern), [
    [['git', 'git.exe'], ['status', 'diff']], ['git', 'status'], ['git', 'status'],
  ], 'saved-list rows retain grouped prefixes and duplicate declarations but exclude restrictions');
  assert.notEqual(summary.allowRules[1].path, summary.allowRules[2].path,
    'matching prefixes from different files remain individually inspectable');
  assert.ok(summary.allowRules.every((entry) => Number.isInteger(entry.start)));
  assert.deepEqual(summary.issues, []);
  assert.ok(summary.blindSpots.some((text) => text.includes('Managed and system-scope')));
  assert.deepEqual(fs.readdirSync(f.rules).map((name) => [name, fs.readFileSync(path.join(f.rules, name), 'hex')]), before);
  assert.deepEqual(fs.readdirSync(f.home), ['selected-codex'], 'WITNESS summary reads create no learner state or backup');
});

test('unsupported files contribute no partial-file count while supported siblings remain visible', (t) => {
  const f = fixture(t);
  f.write('known.rules', rule(['rg']) + rule(['git', 'push'], 'prompt'));
  const unknown = f.write('computed.rules', rule(['must-not-count']) + 'value = "computed"\n');
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 1, prompt: 1, forbidden: 0, total: 2, complete: false },
    'WITNESS an unsupported file cannot inflate known counts or erase readable siblings');
  assert.equal(summary.issues.length, 1);
  assert.deepEqual(summary.allowRules.map(({ pattern }) => pattern), [['rg']],
    'an unsupported file contributes no misleading partial preview');
  assert.equal(summary.issues[0].path, unknown);
  assert.match(summary.issues[0].reason, /Unsupported/);
  assert.equal(summary.files.find((file) => file.path === unknown).supported, false);
});

test('empty and missing rule directories are complete zero counts', (t) => {
  const f = fixture(t);
  for (const codexHome of [f.codexHome, path.join(f.home, 'missing-codex')]) {
    const summary = f.read({ codexHome });
    assert.deepEqual(counts(summary), { allow: 0, prompt: 0, forbidden: 0, total: 0, complete: true });
    assert.deepEqual(summary.files, []);
    assert.deepEqual(summary.issues, []);
  }
});

test('unreadable files report a partial known subtotal and do not become zero approvals', (t) => {
  const f = fixture(t);
  const unreadable = f.write('private.rules', rule(['secret']));
  f.write('readable.rules', rule(['git', 'status']));
  const read = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', (file, ...args) => {
    if (file === unreadable) throw Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
    return read(file, ...args);
  });
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 1, prompt: 0, forbidden: 0, total: 1, complete: false },
    'WITNESS an unreadable sibling makes the displayed count incomplete');
  assert.deepEqual(summary.issues, [{ path: unreadable, reason: 'fixture access denied' }]);
});

test('directory enumeration failures are unknown rather than complete zero counts', (t) => {
  const f = fixture(t);
  const read = fs.readdirSync;
  t.mock.method(fs, 'readdirSync', (directory, ...args) => {
    if (directory === f.rules) throw Object.assign(new Error('fixture directory access denied'), { code: 'EACCES' });
    return read(directory, ...args);
  });
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 0, prompt: 0, forbidden: 0, total: 0, complete: false },
    'WITNESS unreadable directory is not reported as verified zero');
  assert.deepEqual(summary.issues, [{ path: f.rules, reason: 'fixture directory access denied' }]);
});

test('custom Codex home wins and Auto Learn scope off does not hide existing rules', (t) => {
  const f = fixture(t);
  const defaultRules = path.join(f.home, '.codex', 'rules');
  fs.mkdirSync(defaultRules, { recursive: true });
  fs.writeFileSync(path.join(defaultRules, 'default.rules'), rule(['wrong-home']) + rule(['another-wrong-home']));
  f.write('selected.rules', rule(['selected']));
  assert.deepEqual(counts(f.read({ codexScope: 'off', codexRulesPath: null })),
    { allow: 1, prompt: 0, forbidden: 0, total: 1, complete: true },
    'WITNESS disabling automatic writes leaves selected-profile saved permissions visible');
  assert.equal(readCodexPermissionSummary({ home: f.home }).allow, 2,
    'WITNESS explicit home also supports its normal .codex layout');
});

test('an explicit target outside the user rules directory is included without double counting an in-directory target', (t) => {
  const f = fixture(t);
  const inside = f.write('selected.rules', rule(['inside']));
  const outside = path.join(f.home, 'explicit-target.rules');
  fs.writeFileSync(outside, rule(['outside'], 'forbidden'));
  assert.deepEqual(counts(f.read({ target: outside })), { allow: 1, prompt: 0, forbidden: 1, total: 2, complete: true });
  assert.equal(f.read({ target: inside }).total, 1, 'WITNESS selected target is not counted twice');
});

test('non-regular rules and invalid UTF-8 stay explicit unknown inputs', (t) => {
  const f = fixture(t);
  const directory = path.join(f.rules, 'directory.rules');
  fs.mkdirSync(directory);
  const invalid = f.write('invalid.rules', Buffer.from([0xff, 0xfe]));
  const summary = f.read();
  assert.deepEqual(counts(summary), { allow: 0, prompt: 0, forbidden: 0, total: 0, complete: false });
  assert.equal(summary.issues.length, 2);
  assert.match(summary.issues.find((entry) => entry.path === directory).reason, /non-regular/);
  assert.match(summary.issues.find((entry) => entry.path === invalid).reason, /UTF-8/);
});
