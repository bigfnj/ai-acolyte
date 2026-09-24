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
  const packageAt = source.indexOf('execSync(`npx --yes @vscode/vsce package');
  const gateAt = source.indexOf('assertRetiredMaxAbsent(out)');
  assert.ok(packageAt >= 0, 'the supported package command must invoke vsce');
  assert.ok(gateAt > packageAt, 'the content gate must inspect the artifact vsce actually wrote');
});
