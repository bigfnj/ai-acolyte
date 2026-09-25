#!/usr/bin/env node
// Post-condition for a release build. Run it AFTER scripts/package.mjs.
//
//   node scripts/check-version-sync.mjs           # this repo
//   node scripts/check-version-sync.mjs <root>    # another tree (used by the tests)
//
// Why this exists as a separate step rather than another assertion in `npm test`:
// .github/workflows/release.yml runs the tests first and packages second, so every
// guard inside `npm test` is blind to whatever the packaging step does to the
// manifests. test/installers.test.js:511 — "the two package manifests report the
// same version" — still could not catch the release path pulling them apart. This
// runs on the far side of that step, against the artefact about to be uploaded.
//
// Exits non-zero with the specific disagreement named, so a failed release build says
// what is wrong rather than just which step failed.

import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { BUILD_STAMP, artefactName, readBuildStamp } from './build-stamp.mjs';

const root = process.argv[2] || join(dirname(fileURLToPath(import.meta.url)), '..');
const version = (...parts) => JSON.parse(readFileSync(join(root, ...parts), 'utf8')).version;
const at = (ms) => new Date(ms).toISOString();

const problems = [];

const rootVersion = version('package.json');
const extVersion = version('vscode-extension', 'package.json');

if (rootVersion !== extVersion) {
  problems.push(
    `the manifests disagree after packaging: package.json is ${rootVersion} but `
    + `vscode-extension/package.json is ${extVersion}. The sidebar badge would read `
    + `${extVersion} while \`wildcard-perms --version\` printed ${rootVersion}.`);
}

// Checked by name rather than by listing *.vsix, because a working checkout accumulates
// older builds and their presence is not an error. The name alone was not enough: it proved
// only that SOME build, SOME day, produced this version. The checkout this was written on
// held seven of them, 1.4.2 through 1.4.8, so a packaging step that never ran leaves last
// week's same-version artefact sitting there to satisfy the check and be uploaded.
//
// What makes it this build's artefact is the stamp package.mjs writes immediately before it
// invokes vsce. Rejected alternatives:
//   - "mtime newer than this process started" is INVERTED. The checker runs on the far side
//     of packaging, so a genuinely fresh artefact is always older than this process, and no
//     real build would pass.
//   - "newer than vscode-extension/package.json" is blind on most builds. syncVersion writes
//     nothing without a version override, and nothing even with one when the manifest already
//     carries that version, which is the ordinary tag build; the manifest mtime is then just
//     the checkout time and every leftover clears it.
//   - the synced vscode-extension/src/ tree is not a witness either. Measured: fs.cpSync keeps
//     the SOURCE mtime on Windows and takes "now" on Linux, so one comparison would mean two
//     different things on a developer box and on the ubuntu runner CI actually uses.
//   - taking the expected NAME from package.mjs would let the step under audit hand over the
//     expectation it is audited against. The name still comes from the manifest here. The
//     stamp supplies only the time, and a stamp naming some OTHER artefact is itself reported
//     -- that is the "read the manifest before the sync" bug, caught independently.
const expected = artefactName(extVersion);
const artefact = join(root, expected);
const stamped = readBuildStamp(root);

if (!existsSync(artefact)) {
  problems.push(`packaging did not produce ${expected}`);
} else if (!stamped) {
  problems.push(
    `${expected} is here but ${BUILD_STAMP} is missing or unreadable, so nothing in this tree `
    + 'shows a packaging step ran at all. Run `node scripts/package.mjs` first.');
} else if (stamped.stamp.artefact !== expected) {
  problems.push(
    `the build stamp says packaging wrote ${stamped.stamp.artefact}, but the manifests call `
    + `for ${expected}. ${stamped.stamp.artefact} is the file that would be uploaded.`);
} else if (statSync(artefact).mtimeMs < stamped.mtimeMs) {
  // `<`, so equal timestamps pass: both writes can land in the same millisecond on a fast
  // machine, while a leftover is older by a whole build cycle and never by a rounding error.
  problems.push(
    `${expected} is OLDER than the packaging step that should have written it (artefact `
    + `${at(statSync(artefact).mtimeMs)}, build started ${at(stamped.mtimeMs)}), so it is a `
    + 'leftover from an earlier build of the same version, not the artefact of this one.');
}

if (problems.length) {
  console.error('release version check FAILED');
  for (const problem of problems) console.error(`  - ${problem}`);
  process.exit(1);
}

console.log(`release version check OK: ${extVersion}, ${expected}`);
