#!/usr/bin/env node
// Post-condition for a release build. Run it AFTER scripts/package.mjs.
//
//   node scripts/check-version-sync.mjs           # this repo
//   node scripts/check-version-sync.mjs <root>    # another tree (used by the tests)
//
// Why this exists as a separate step rather than another assertion in `npm test`:
// .github/workflows/release.yml runs the tests first and packages second, so every
// guard inside `npm test` is blind to whatever the packaging step does to the
// manifests. test/installers.test.js:455 asserts the two manifests agree and still
// could not catch the release path pulling them apart. This runs on the far side of
// that step, against the artefact about to be uploaded.
//
// Exits non-zero with the specific disagreement named, so a failed release build says
// what is wrong rather than just which step failed.

import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const version = (...parts) => JSON.parse(readFileSync(join(root, ...parts), 'utf8')).version;

const problems = [];

const rootVersion = version('package.json');
const extVersion = version('vscode-extension', 'package.json');

if (rootVersion !== extVersion) {
  problems.push(
    `the manifests disagree after packaging: package.json is ${rootVersion} but `
    + `vscode-extension/package.json is ${extVersion}. The sidebar badge would read `
    + `${extVersion} while \`wildcard-perms --version\` printed ${rootVersion}.`);
}

// Checked by name rather than by listing *.vsix, because a working checkout
// accumulates older builds and their presence is not an error.
const expected = `permission-wildcarding-${extVersion}.vsix`;
if (!existsSync(join(root, expected))) {
  problems.push(`packaging did not produce ${expected}`);
}

if (problems.length) {
  console.error('release version check FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`release version check OK: ${extVersion}, ${expected}`);
