'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { restoreCodexClaims, readCodexClaims, renderCodexClaims, updateCodexClaims } = require('../src/codex-claims');
const { parseCodexRules } = require('../src/codex-rule-inventory');
const { renderCodexRules, mergeGeneratedCodexRules, CODEX_BEGIN_MARKER } = require('../src/policy-exporters');

const target = 'fixture-rule-target';
const alice = 'state-sha256:' + 'a'.repeat(24);
const bob = 'state-sha256:' + 'b'.repeat(24);
const rule = (prefix) => {
  const text = renderCodexRules([{ prefix, autoSafe: true, successCount: 3 }]);
  const parsed = parseCodexRules(text);
  assert.equal(parsed.rules.length, 1);
  return text.slice(parsed.rules[0].start, parsed.rules[0].end);
};
const git = rule(['git', 'status']);
const rg = rule(['rg', '--files']);
const pwd = rule(['pwd']);
const liveFile = (body) => `# owner café\r\n${CODEX_BEGIN_MARKER}\n${body}\n${CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ')}\n`;
const claims = (baseline = '', claimants = {}) => ({ version: 1, target, baseline, claimants });
const patterns = (text) => parseCodexRules(text).rules.map((entry) => entry.pattern);

test('claims restore keeps live shared owners but restores deleted declarations only as baseline', () => {
  const saved = claims('', { [alice]: git + '\n\n' + rg, [bob]: rg });
  const before = JSON.stringify(saved);
  const result = restoreCodexClaims(saved, target, liveFile(rg), [git]);
  assert.deepEqual(patterns(result.claims.claimants[alice]), [['rg', '--files']],
    'WITNESS deleted declaration does not regain its old claimant');
  assert.equal(result.claims.claimants[bob], rg, 'WITNESS other live workspace ownership survives restoration');
  assert.equal(result.claims.baseline, git);
  assert.equal(JSON.stringify(saved), before, 'input claims are not mutated');
  const roundtrip = readCodexClaims({ exists: true, content: Buffer.from(renderCodexClaims(result.claims)) }, target);
  assert.deepEqual(roundtrip, result.claims);
  const merged = mergeGeneratedCodexRules(liveFile(rg), result.generated);
  assert.ok(merged.startsWith('# owner café\r\n'));
  assert.doesNotThrow(() => updateCodexClaims(result.claims, target, bob, rg, merged));
});

test('claims restore preserves unknown live declarations without reviving missing baseline or dead owners', () => {
  const saved = claims(git, { [alice]: rg });
  const result = restoreCodexClaims(saved, target, liveFile(pwd), []);
  assert.deepEqual(patterns(result.generated), [['pwd']],
    'WITNESS old missing baseline never returns without explicit selection');
  assert.deepEqual(result.claims.claimants, {}, 'WITNESS entirely missing owners are removed');
  assert.equal(result.claims.baseline, pwd, 'unknown live rules become baseline');
  const missing = restoreCodexClaims(saved, target, '# owner only\n', [git]);
  assert.deepEqual(missing.claims.claimants, {});
  assert.equal(missing.claims.baseline, git);
  const external = restoreCodexClaims(saved, target, rg + '\n', [git]);
  assert.deepEqual(external.claims.claimants, {}, 'external copies cannot preserve generated claims');
  assert.equal(external.claims.baseline, git);
});

test('claims restore requires exact live declarations and deduplicates already present or repeated restores', () => {
  const changed = rg.replace('3 successful', '4 successful');
  assert.notEqual(changed, rg);
  const result = restoreCodexClaims(claims('', { [alice]: rg }), target, liveFile(changed), [git, git, changed]);
  assert.deepEqual(result.claims.claimants, {},
    'WITNESS changed live metadata does not prove the old claimant still owns the declaration');
  assert.deepEqual(patterns(result.generated), [['rg', '--files'], ['git', 'status']],
    'WITNESS live and repeated restored declarations are not duplicated');
  const unchanged = restoreCodexClaims(claims('', { [alice]: rg }), target, liveFile(rg), [rg]);
  assert.equal(unchanged.claims.claimants[alice], rg);
  assert.equal(unchanged.claims.baseline, '');
});

test('claims restore refuses unsupported files ambiguous markers malformed claims and noncanonical managed rules', () => {
  const crossing = `prefix_rule(\n${CODEX_BEGIN_MARKER}\npattern=["git"], decision="allow")\n${CODEX_BEGIN_MARKER.replace('BEGIN ', 'END ')}`;
  for (const existing of [liveFile(rg) + '\ncomputed()', liveFile(rg) + '\n' + CODEX_BEGIN_MARKER,
    crossing, liveFile('prefix_rule(pattern=["tool"], decision="forbidden")')]) {
    assert.throws(() => restoreCodexClaims(null, target, existing, [git]), /Cannot/,
      'WITNESS unsupported generated ownership remains read-only');
  }
  assert.throws(() => restoreCodexClaims({ ...claims(), target: 'different' }, target, liveFile(rg), []), /malformed or unsupported/);
  assert.throws(() => restoreCodexClaims({ ...claims(), version: 2 }, target, liveFile(rg), []), /malformed or unsupported/);
  assert.throws(() => restoreCodexClaims(claims('', { bad: rg }), target, liveFile(rg), []), /claimant id/);
  assert.throws(() => restoreCodexClaims(null, target, liveFile(rg), [git + '\n' + pwd]), /exactly one/);
  assert.throws(() => restoreCodexClaims(null, target, liveFile(rg), ['# comment\n' + git]), /exactly one/);
  assert.throws(() => restoreCodexClaims(null, target, liveFile(rg), ['computed()']), /unsupported/);
});
