'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const gateUrl = pathToFileURL(
  path.resolve(__dirname, '..', 'scripts', 'assert-retired-max-absent.mjs'),
).href;

test('packaged MAX-removal gate accepts cleanup-only runtime code', async () => {
  const { assertNoRetiredMaxEntries } = await import(gateUrl);
  assert.doesNotThrow(() => assertNoRetiredMaxEntries([
    { name: 'extension/extension.js', text: 'removeLegacyClaudeMax();' },
    { name: 'extension/src/legacy-max-cleanup.js', text: 'function removeLegacyCodexMax() {}' },
    { name: 'extension/package.json', text: '{"commands":[]}' },
  ], 'clean-fixture'));
});

test('packaged MAX-removal gate fires on every retired enabling symbol', async () => {
  const { assertNoRetiredMaxEntries } = await import(gateUrl);
  for (const symbol of [
    'enableMaxAllow',
    'ensureApproveScript',
    'registerApproveHook',
    'applyMax',
    'applyCodexMax',
    'writeCodexMaxState',
  ]) {
    assert.throws(
      () => assertNoRetiredMaxEntries([
        { name: 'extension/src/permissions.js', text: `function ${symbol}() {}` },
      ], `${symbol}-mutant`),
      new RegExp(`permissions\\.js: retired enabling symbol ${symbol}`),
      `${symbol} mutant must fire the package gate`,
    );
  }
});

test('packaged MAX-removal gate fires on the retired file and manifest contributions', async () => {
  const { assertNoRetiredMaxEntries } = await import(gateUrl);
  assert.throws(
    () => assertNoRetiredMaxEntries([
      { name: 'extension/src/codex-max.js', text: "'use strict';" },
    ], 'file-mutant'),
    /codex-max\.js: retired implementation file is packaged/,
  );
  for (const key of [
    'permission-wildcarding.toggleMax',
    'permission-wildcarding.toggleCodexMax',
    'permissionWildcarding.maxMode',
    'permissionWildcarding.codexMaxMode',
  ]) {
    assert.throws(
      () => assertNoRetiredMaxEntries([
        { name: 'extension/package.json', text: JSON.stringify({ key }) },
      ], `${key}-mutant`),
      new RegExp(`retired contribution ${key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`),
    );
  }
});

test('package.mjs inspects the built VSIX after vsce writes it', () => {
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'package.mjs'), 'utf8',
  );
  // `${VSCE}`, the pinned @vscode/vsce@<exact>, since 2026-10-14 (test/release-pins.test.js
  // holds the pin itself); before, the unpinned `@vscode/vsce`.
  const packageAt = source.indexOf('execSync(`npx --yes ${VSCE} package');
  const gateAt = source.indexOf('assertRetiredMaxAbsent(out)');
  assert.ok(packageAt >= 0, 'the supported package command must invoke vsce');
  assert.ok(gateAt > packageAt, 'the content gate must inspect the artifact vsce actually wrote');
});

test('package.mjs quarantines a VSIX the content gate rejects', () => {
  // Calling the gate as a bare statement is the shape that left a refused VSIX, and the
  // stamp vouching for it, in the repo root for check-version-sync.mjs to pass. The
  // quarantine's behaviour is driven on junk files in test/release-version.test.js; this
  // pins that package.mjs actually routes the gate through it, with the stamp path
  // writeBuildStamp writes (join(root, BUILD_STAMP)).
  const source = fs.readFileSync(
    path.resolve(__dirname, '..', 'scripts', 'package.mjs'), 'utf8',
  );
  assert.doesNotMatch(source, /^\s*assertRetiredMaxAbsent\(out\)\s*;/m,
    'the gate is called bare again, so a rejection leaves the artefact and stamp behind');
  assert.match(source,
    /gateOrQuarantine\(\s*out,\s*join\(root, BUILD_STAMP\),\s*\(\)\s*=>\s*assertRetiredMaxAbsent\(out\)\s*\)/,
    'the gate must run inside gateOrQuarantine, over `out`, with the stamp this build wrote');
  assert.ok(
    source.indexOf('gateOrQuarantine(out') > source.indexOf('execSync(`npx --yes ${VSCE} package'),
    'and after vsce, like the gate itself');
});
