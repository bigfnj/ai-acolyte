'use strict';

// The release toolchain is pinned, and runs on the Node its pin supports.
//
// Found 2026-10-14 (the v1.6.2 CI audit): scripts/package.mjs ran `npx --yes @vscode/vsce`
// unpinned, which resolves to whatever is latest on the day, and .github/workflows/release.yml
// ran it on Node 20. vsce 4.0.0 (2026-09-14) declares engines.node ">= 22"; npx only warns
// on that (`npm warn EBADENGINE`, measured in node:20-slim) and ran it, so the v1.6.2 VSIX
// was built on an unsupported pair and the next vsce could as easily have refused. Now
// package.mjs pins an exact version and release.yml moves ONLY the package step to Node 22,
// keeping the suite on Node 20, the floor README.md promises. test.yml gained a Node 24 leg
// the same day, the extension host's own runtime, which nothing in CI tested.
//
// Static on purpose: CI is where these files run, and nothing here can reach the registry.
// The engine floor below is the pinned version's declared engines.node, read from the npm
// registry on 2026-10-14; bumping the pin means re-reading it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
const VSCE_ENGINE_FLOOR = { '4.0.0': 22 };

// The node-version of the last actions/setup-node before the step named `name` in a
// workflow, read line by line (the files are hand-written, two-space YAML).
function nodeBefore(workflow, name) {
  const lines = workflow.split(/\r?\n/);
  const at = lines.findIndex((line) => line.trim() === `- name: ${name}`);
  assert.notEqual(at, -1, `no step named ${name}`);
  for (let i = at - 1; i >= 0; i -= 1) {
    if (/uses:\s*actions\/setup-node@/.test(lines[i])) {
      const version = /node-version:\s*"?(\d+)"?/.exec(lines.slice(i, i + 4).join('\n'));
      assert.ok(version, `the setup-node before ${name} names no literal node-version`);
      return Number(version[1]);
    }
  }
  assert.fail(`no setup-node before ${name}`);
}

test('package.mjs runs an exact vsce, never whatever npm calls latest', () => {
  const source = read('scripts/package.mjs');
  const pin = /const VSCE = '@vscode\/vsce@(\d+\.\d+\.\d+)';/.exec(source);
  assert.ok(pin, 'VSCE must be an exact @vscode/vsce@X.Y.Z (no range, no tag, no bare name)');
  assert.ok(source.includes('execSync(`npx --yes ${VSCE} package'), 'and the package command must use it');
  const code = source.split('\n').filter((line) => !line.trimStart().startsWith('//')).join('\n');
  assert.doesNotMatch(code, /@vscode\/vsce(?!@\d)/, 'no unpinned vsce anywhere in the code (comments may name the old spelling)');
  assert.ok(VSCE_ENGINE_FLOOR[pin[1]], `vsce ${pin[1]}: record its engines.node floor here before using it`);
});

test('release.yml packages on the Node the pinned vsce supports, and tests on the Node 20 floor', () => {
  const release = read('.github/workflows/release.yml');
  const pin = /const VSCE = '@vscode\/vsce@(\d+\.\d+\.\d+)';/.exec(read('scripts/package.mjs'))[1];
  assert.ok(nodeBefore(release, 'Package VSIX') >= VSCE_ENGINE_FLOOR[pin],
    `the package step must run on Node ${VSCE_ENGINE_FLOOR[pin]}+ for vsce ${pin}`);
  assert.equal(nodeBefore(release, 'Test'), 20, 'the release suite stays on the floor README.md names');
});

test('test.yml runs the suite on Node 20, 22 and 24, on both platforms, without fail-fast', () => {
  const workflow = read('.github/workflows/test.yml');
  assert.match(workflow, /^\s*node: \["20", "22", "24"\]\s*$/m);
  assert.match(workflow, /^\s*os: \[ubuntu-latest, windows-latest\]\s*$/m);
  assert.match(workflow, /^\s*fail-fast: false\s*$/m);
});
