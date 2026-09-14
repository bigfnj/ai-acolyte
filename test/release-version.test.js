'use strict';

// The release path had a hole that no test could reach.
//
// .github/workflows/release.yml runs `npm test`, then `node scripts/package.mjs "<tag>"`.
// That override used to write the tag into vscode-extension/package.json and nothing
// else, leaving the root manifest behind. The root manifest is what
// `bin/wildcard-perms --version` prints and the extension manifest is what the sidebar
// badge shows, so one build reported two different versions. installers.test.js:455
// already asserts the two agree, and was structurally blind to this: it ran before the
// step that broke them.
//
// So this file covers both halves. syncVersion is driven directly, against throwaway
// manifests, and check-version-sync.mjs is run as CI runs it, as a process whose exit
// code is the result.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const repoRoot = path.resolve(__dirname, '..');
const checker = path.join(repoRoot, 'scripts', 'check-version-sync.mjs');

// A minimal tree with the two manifests the release path cares about. Real ones carry
// far more, which is the point of writing the whole object back out: a version bump
// must not be the only key that survives.
function fixture({ root = '1.0.0', ext = '1.0.0', vsix = null } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'pw-release-'));
  fs.mkdirSync(path.join(dir, 'vscode-extension'));
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'permission-wildcarding', version: root, license: 'MIT',
  }, null, 2) + '\n');
  fs.writeFileSync(path.join(dir, 'vscode-extension', 'package.json'), JSON.stringify({
    name: 'permission-wildcarding', version: ext, publisher: 'local',
  }, null, 2) + '\n');
  if (vsix) fs.writeFileSync(path.join(dir, `permission-wildcarding-${vsix}.vsix`), 'x');
  return dir;
}

const versionIn = (dir, ...parts) =>
  JSON.parse(fs.readFileSync(path.join(dir, ...parts), 'utf8')).version;

function runChecker(dir) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [checker, dir], { encoding: 'utf8' }) };
  } catch (err) {
    return { code: err.status, out: `${err.stdout || ''}${err.stderr || ''}` };
  }
}

function withFixture(options, body) {
  const dir = fixture(options);
  try {
    body(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a version override reaches BOTH manifests, not only the extension one', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({}, (dir) => {
    const applied = syncVersion(dir, '9.9.9');

    assert.equal(versionIn(dir, 'vscode-extension', 'package.json'), '9.9.9');
    assert.equal(versionIn(dir, 'package.json'), '9.9.9',
      'the root manifest kept its old version, so `wildcard-perms --version` would '
      + 'disagree with the sidebar badge for the same build');
    assert.deepEqual(applied.changed, ['vscode-extension/package.json', 'package.json']);
    assert.equal(applied.version, '9.9.9');
  });
});

test('a release tag keeps its leading v out of the manifests', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({}, (dir) => {
    // release.yml passes github.event.release.tag_name straight through, and the tags
    // on this repo are v1.4.1, v1.4.0, v1.3.0 ...
    assert.equal(syncVersion(dir, 'v2.0.0').version, '2.0.0');
    assert.equal(versionIn(dir, 'package.json'), '2.0.0');
    assert.equal(versionIn(dir, 'vscode-extension', 'package.json'), '2.0.0');
  });
});

test('no override leaves both manifests untouched', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({ root: '1.2.3', ext: '1.2.3' }, (dir) => {
    // workflow_dispatch's version input is optional, so this is the normal local build.
    for (const absent of [undefined, '', '  ']) {
      assert.equal(syncVersion(dir, absent), null);
      assert.equal(versionIn(dir, 'package.json'), '1.2.3');
      assert.equal(versionIn(dir, 'vscode-extension', 'package.json'), '1.2.3');
    }
  });
});

test('other manifest keys survive a version rewrite', async () => {
  const { syncVersion } = await import('../scripts/sync-version.mjs');
  withFixture({}, (dir) => {
    syncVersion(dir, '3.0.0');
    const ext = JSON.parse(fs.readFileSync(
      path.join(dir, 'vscode-extension', 'package.json'), 'utf8'));
    assert.equal(ext.publisher, 'local');
    assert.equal(JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).license,
      'MIT');
  });
});

test('the release check passes when the manifests agree and the VSIX was built', () => {
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.5' }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 0, out);
    assert.match(out, /release version check OK: 1\.4\.5/);
  });
});

test('the release check fails, naming both numbers, when the manifests drift', () => {
  // This is the exact state the old package.mjs left behind on a tag build.
  withFixture({ root: '1.4.4', ext: '1.4.5', vsix: '1.4.5' }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 1, 'drifted manifests must fail the release build');
    assert.match(out, /package\.json is 1\.4\.4/);
    assert.match(out, /vscode-extension\/package\.json is 1\.4\.5/);
  });
});

test('the release check fails when packaging produced no matching VSIX', () => {
  withFixture({ root: '1.4.5', ext: '1.4.5', vsix: '1.4.4' }, (dir) => {
    const { code, out } = runChecker(dir);
    assert.equal(code, 1, 'a VSIX named for a different version is not this build');
    assert.match(out, /did not produce permission-wildcarding-1\.4\.5\.vsix/);
  });
});
