#!/usr/bin/env node
'use strict';

// Which codex-cli the product would launch, read the way the product reads it.
//
//   node scripts/check-codex-version.js [--codex <executable>] [--expect <X.Y.Z>]
//
// Prints the src/codex-version.js status as JSON: the executable, the file it
// resolved to, the parsed version, and the verdict against the declared window.
// With no `--expect` it only reports and always exits 0, because the product's
// own stance is that a version outside the window is information, not failure.
//
// `--expect` is for CI (.github/workflows/test.yml, added 2026-10-13), which
// installs a PINNED Codex so the contract tests stop skipping. It fails loudly
// when:
//   - the binary the product would launch is not that exact version (a second
//     codex earlier on PATH, a moved npm prefix, a registry that resolved the
//     pin differently), or
//   - the pin itself is not a version this repository has recorded evidence
//     for (CODEX_TESTED_VERSIONS). Bumping the CI pin is a claim that the new
//     build was exercised; record it in docs/codex-compatibility.md and the
//     tested list first, and this check is what stops the order being reversed.
// It resolves through the product's own exec-resolve path, the same one the
// contract tests use, so "the step passed" and "the tests ran against it" are
// one fact rather than two.
const { codexVersionStatus, CODEX_TESTED_VERSIONS, CODEX_VERSION_WINDOW } = require('../src/codex-version');

const args = process.argv.slice(2);
const usage = 'usage: check-codex-version.js [--codex <executable>] [--expect <X.Y.Z>]';
const options = {};
for (let index = 0; index < args.length; index += 2) {
  if (!['--codex', '--expect'].includes(args[index]) || !args[index + 1]) {
    process.stderr.write(`${usage}\n`);
    process.exit(2);
  }
  options[args[index]] = args[index + 1];
}

const status = codexVersionStatus({ executable: options['--codex'] || 'codex', timeoutMs: 30000 });
process.stdout.write(`${JSON.stringify({ ...status, declaredWindow: CODEX_VERSION_WINDOW }, null, 2)}\n`);

const expected = options['--expect'];
if (expected) {
  const tested = CODEX_TESTED_VERSIONS.map((entry) => entry.version);
  const problems = [];
  if (!tested.includes(expected)) {
    problems.push(`pinned ${expected} is not a recorded tested version (${tested.join(', ')}); `
      + 'record its evidence in docs/codex-compatibility.md and src/codex-version.js first');
  }
  if (status.version !== expected) {
    problems.push(`the product would launch ${status.version ? `codex-cli ${status.version}` : 'no readable codex-cli'} `
      + `from ${status.resolved || status.executable}, not the pinned ${expected}${status.reason ? ` (${status.reason})` : ''}`);
  }
  for (const problem of problems) process.stderr.write(`::error::check-codex-version: ${problem}\n`);
  if (problems.length) process.exit(1);
  process.stderr.write(`check-codex-version: codex-cli ${expected} resolved at ${status.resolved}; contract tests will run against it.\n`);
}
