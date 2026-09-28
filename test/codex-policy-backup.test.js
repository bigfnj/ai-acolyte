'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const crypto = require('node:crypto');
const { retainCodexPolicy, planCodexPolicyRestore } = require('../src/codex-policy-backup');
const { CODEX_BEGIN_MARKER } = require('../src/policy-exporters');

const scope = path.resolve('fixture-codex-home');
const file = path.join(scope, 'rules', 'default.rules');
const otherFile = path.join(scope, 'rules', 'other.rules');
const hash = (text) => crypto.createHash('sha256').update(text).digest('hex');
const declaration = (pattern, decision = 'allow') =>
  `prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = ${JSON.stringify(decision)})`;
const managed = (text) => `${CODEX_BEGIN_MARKER}\n${text}\n${CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ')}\n`;
const retain = (catalog, text, options = {}) => retainCodexPolicy(catalog, { scope, path: file, text, ...options });
const plan = (catalog, text = '', options = {}) => planCodexPolicyRestore(catalog, {
  scope, path: file, text, exists: true, expectedExists: true, expectedHash: hash(text),
  suppressedPatterns: [], ...options,
});
const freeze = (value) => {
  if (value && typeof value === 'object') {
    Object.freeze(value);
    Object.values(value).forEach(freeze);
  }
  return value;
};

test('backup high-water retains replaced declarations and keeps each original file separate', () => {
  const a = declaration(['git', 'status']);
  const b = declaration(['rg', '--files']);
  const first = freeze(retain(null, a).catalog);
  const firstBytes = JSON.stringify(first);
  const second = retain(first, b);
  assert.equal(second.addedCount, 1);
  assert.equal(second.catalog.files[0].rules.length, 2,
    'WITNESS same-sized replacement retains both historical declarations');
  assert.equal(JSON.stringify(first), firstBytes);
  assert.deepEqual(retain(second.catalog, '').catalog, second.catalog);
  const separate = retain(second.catalog, a, { path: otherFile });
  assert.equal(separate.catalog.files.length, 2);
  assert.equal(separate.addedCount, 1);
  assert.equal(plan(separate.catalog).restore.length, 2,
    'WITNESS restore is restricted to the requested original file');
  assert.equal(plan(separate.catalog, '', { path: otherFile }).restore.length, 1);
  assert.equal(plan(separate.catalog, '', { selectedIds: [] }).restore.length, 0);
});

test('backup preserves exact Unicode CRLF declarations while deduplicating metadata and alternative order', () => {
  const original = 'prefix_rule(\r\n pattern=["tool", ["λ", "café", "λ"]],\r\n decision="allow", justification="first 🚀",\r\n)';
  const changed = 'prefix_rule(pattern=["tool", ["café", "λ"]], decision="allow", justification="second")';
  const first = retain(null, '# owner\r\n' + original + ' # trailing\r\n');
  const second = retain(first.catalog, changed);
  assert.equal(second.changed, false,
    'WITNESS metadata and alternative ordering do not create duplicate policy history');
  assert.equal(second.catalog.files[0].rules[0].text, original,
    'WITNESS retained declaration bytes include original CRLF and Unicode');
  assert.deepEqual(second.catalog.files[0].rules[0].pattern, ['tool', ['café', 'λ']]);
  assert.equal(plan(second.catalog, changed).present.length, 1);
  const distinct = retain(second.catalog, declaration([['café', 'λ'], 'tool']) + '\n' + declaration(['Tool', ['café', 'λ']]));
  assert.equal(distinct.addedCount, 2, 'argv position and case remain distinct');
});

test('backup whole-file refusal retains prior catalog and exposes no partial restoration plan', () => {
  const valid = declaration(['git', 'status']);
  const catalog = freeze(retain(null, valid).catalog);
  const badTexts = [valid + '\ncomputed()', managed(valid) + CODEX_BEGIN_MARKER,
    `prefix_rule(\n${CODEX_BEGIN_MARKER}\npattern=["git"], decision="allow")\n${CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ')}`,
    valid + '\ud800'];
  for (const text of badTexts) {
    const captured = retain(catalog, text);
    assert.equal(captured.supported, false, 'WITNESS unsupported files cannot add partial history');
    assert.equal(captured.changed, false);
    assert.deepEqual(captured.catalog, catalog);
    const result = plan(catalog, text);
    assert.equal(result.supported, false, 'WITNESS unsupported current files cannot yield restore writes');
    assert.deepEqual([result.restore, result.present, result.suppressed, result.conflicts], [[], [], [], []]);
  }
});

test('restore refuses stale file bytes existence and fabricated or foreign selections', () => {
  const first = retain(null, declaration(['git', 'status'])).catalog;
  const catalog = retain(first, declaration(['rg', '--files']), { path: otherFile }).catalog;
  const current = '# owner';
  assert.throws(() => plan(catalog, current, { expectedHash: hash('') }), /selection is stale/,
    'WITNESS changed file bytes invalidate reviewed restoration');
  assert.throws(() => plan(catalog, '', { exists: false, expectedExists: true }), /selection is stale/,
    'WITNESS absent and empty files are distinct reviewed states');
  assert.equal(plan(catalog, '', { exists: false, expectedExists: false }).restore.length, 1);
  const foreign = catalog.files.find((entry) => entry.path.endsWith('other.rules')).rules[0].id;
  const own = catalog.files.find((entry) => entry.path.endsWith('default.rules')).rules[0].id;
  assert.throws(() => plan(catalog, '', { selectedIds: [foreign] }), /another file/,
    'WITNESS selected declarations resolve only against their original file');
  assert.throws(() => plan(catalog, '', { selectedIds: ['f'.repeat(64)] }), /selection is stale/);
  assert.throws(() => plan(catalog, '', { selectedIds: [own, own] }), /unique/);
  assert.throws(() => plan(catalog, '', { suppressedPatterns: undefined }), /current removal-suppression/);
  assert.throws(() => plan(catalog, '', { exists: undefined }), /reviewed file hash\/existence/);
});

test('restore suppression blocks broad narrow and alternative overlap without suppressing restrictions or disjoint rules', () => {
  const cases = [
    [['git'], ['git', 'status'], true],
    [['git', 'status'], ['git'], true],
    [['git', ['status', 'log']], ['git', 'log', '--oneline'], true],
    [[['git', 'git.exe'], 'status'], ['git.exe', 'status'], true],
    [['git', ['status', 'log']], ['git', ['push', 'fetch']], false],
    [['git', 'status-extra'], ['git', 'status'], false],
    [['Git', 'status'], ['git', 'status'], false],
  ];
  for (const [saved, removed, blocked] of cases) {
    const catalog = retain(null, ['allow', 'prompt', 'forbidden'].map((decision) => declaration(saved, decision)).join('\n')).catalog;
    const result = plan(catalog, '', { suppressedPatterns: [removed] });
    assert.equal(result.suppressed.length, blocked ? 1 : 0,
      'WITNESS explicit removal blocks every overlapping saved allow: ' + JSON.stringify([saved, removed]));
    assert.deepEqual(result.restore.map((rule) => rule.decision).sort(),
      blocked ? ['forbidden', 'prompt'] : ['allow', 'forbidden', 'prompt'],
      'WITNESS restoration retains restrictions and disjoint allow rules');
  }
});

test('restore treats current decision changes and generated ownership moves as conflicts', () => {
  const allow = declaration(['git', 'status']);
  const prompt = declaration(['git', 'status'], 'prompt');
  const external = retain(null, allow).catalog;
  const conflict = plan(external, '# keep this\n' + prompt);
  assert.equal(conflict.restore.length, 0, 'WITNESS a changed decision is not a missing permission');
  assert.equal(conflict.conflicts.length, 1, 'WITNESS a changed decision is not a missing permission');
  assert.match(conflict.conflicts[0].reason, /different decision/);
  const generated = retain(null, managed(allow)).catalog;
  const moved = plan(generated, allow);
  assert.equal(moved.restore.length, 0);
  assert.equal(moved.conflicts.length, 1, 'WITNESS an external copy cannot silently regain generated ownership');
  assert.match(moved.conflicts[0].reason, /ownership/);
  assert.equal(plan(generated, managed(allow)).present.length, 1);
  assert.equal(plan(external, managed(allow)).conflicts.length, 1);
  assert.notEqual(generated.files[0].rules[0].id, external.files[0].rules[0].id);
  const missing = plan(generated);
  assert.equal(missing.restore[0].managed, true);
  assert.equal(Object.hasOwn(missing.restore[0], 'claimants'), false,
    'historical generated provenance does not recreate old workspace ownership');
});

test('backup rejects malformed durable catalogs instead of silently losing retained history', () => {
  const catalog = retain(null, declaration(['git', 'status'])).catalog;
  const copy = () => JSON.parse(JSON.stringify(catalog));
  const invalid = [
    { ...copy(), version: 2 },
    { ...copy(), scope: path.resolve('other-home') },
    { ...copy(), files: [...copy().files, ...copy().files] },
  ];
  const changedId = copy();
  changedId.files[0].rules[0].id = 'f'.repeat(64);
  invalid.push(changedId);
  const changedText = copy();
  changedText.files[0].rules[0].text = declaration(['git', 'push']);
  invalid.push(changedText);
  const duplicate = copy();
  duplicate.files[0].rules.push(duplicate.files[0].rules[0]);
  invalid.push(duplicate);
  for (const value of invalid) {
    assert.throws(() => retain(value, ''), /Cannot use/,
      'WITNESS malformed durable history refuses rather than resets');
    assert.throws(() => plan(value), /Cannot use/);
  }
});
