'use strict';

// THE SHELL GUIDANCE'S CODEX CLAIMS, CHECKED AGAINST THE REAL RULE CHECKER.
//
// src/agent-guidance.js writes one body into both agents' instruction files. Its
// Codex sentences are claims about Codex, and until 2026-10-13 nothing asked
// Codex whether they were true. This matrix asks `codex execpolicy check`, with a
// temporary rules file and a temporary CODEX_HOME, about one argv per shell
// spelling the guidance warns about, and asserts the decision Codex returns.
// Each row quotes the guidance sentence it tests, and the first test fails if a
// quoted sentence is no longer in the body, so rewording the guidance sends the
// author back here instead of silently orphaning the check.
//
// WHAT THIS LAYER CAN AND CANNOT SAY. Measured on codex-cli 0.161.0, the checker
// matches raw argv by prefix and never interprets a shell: `bash -lc "git
// status"` gets no match from a `git status` rule, and a chain handed over as
// argv tokens (`git status && rm x`) is matched by its first prefix like any
// other trailing arguments. So the wrapper and script-file claims are answered
// here; the claim that Codex "can split simple shell chains" is a property of
// the runtime approval path, not of this checker, and is answered by
// scripts/check-codex-wrapper-runtime.js (13 of 13 PowerShell cases agree on
// 0.161.0, Windows, 2026-10-13; see docs/codex-compatibility.md). The last row
// below pins the non-splitting so that nobody reads an execpolicy "no match" on
// a wrapped chain as proof the runtime will prompt.
//
// Skips with a banner when no codex binary is reachable, like
// test/codex-contract.test.js; ACOLYTE_REQUIRE_CODEX turns that skip into a
// failure on the CI legs that provision Codex.

const test = require('node:test');
const assert = require('node:assert/strict');
const { spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { commandLaunch } = require('../src/exec-resolve');
const { GUIDANCE_BODY } = require('../src/agent-guidance');

// One hermetic profile for every spawn: the checker accepts -c config overrides,
// so it reads a config file, and the developer's real one is none of its business.
const HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-guidance-matrix-'));
const CODEX_HOME = path.join(HOME, '.codex');
fs.mkdirSync(CODEX_HOME, { recursive: true });
process.on('exit', () => { try { fs.rmSync(HOME, { recursive: true, force: true }); } catch {} });
const ENV = { ...process.env, HOME, USERPROFILE: HOME, CODEX_HOME };

function codex(args) {
  const launch = commandLaunch('codex', args);
  if (process.platform === 'win32' && !launch.resolved) return { status: null, stdout: '', stderr: 'unresolved' };
  const result = spawnSync(launch.file, launch.args, {
    encoding: 'utf8', windowsHide: true, timeout: 60000, env: ENV, ...launch.options,
  });
  if (result.error) return { status: null, stdout: '', stderr: String(result.error.message || result.error) };
  return { status: result.status, stdout: String(result.stdout || ''), stderr: String(result.stderr || '') };
}

const probe = codex(['--version']);
const CODEX_VERSION = probe.status === 0 ? probe.stdout.trim() : null;
const REQUIRED = process.env.ACOLYTE_REQUIRE_CODEX || '';
if (CODEX_VERSION) process.stderr.write(`\n[codex-guidance-matrix] RUNNING against ${CODEX_VERSION} on ${process.platform}.\n\n`);
else {
  process.stderr.write('\n[codex-guidance-matrix] SKIPPED — no reachable `codex` binary. The shell guidance was NOT '
    + 'checked against a real Codex rule checker. This is NOT a pass.\n\n');
}
const skip = CODEX_VERSION ? false : 'no reachable codex binary (see the stderr banner)';

const RULES = path.join(HOME, 'guidance-matrix.rules');
fs.writeFileSync(RULES, [
  'prefix_rule(pattern = ["git", "status"], decision = "allow")',
  'prefix_rule(pattern = ["rg"], decision = "allow")',
  '',
].join('\n'));

// Asynchronous, a few at a time: each spawn costs about half a second of Codex
// start-up (measured 2026-10-13), and twenty in series dominated this file.
function decisionFor(argv) {
  const launch = commandLaunch('codex', ['execpolicy', 'check', '--rules', RULES, '--', ...argv]);
  return new Promise((resolve) => {
    execFile(launch.file, launch.args, { encoding: 'utf8', windowsHide: true, timeout: 60000, env: ENV, ...launch.options },
      (error, stdout, stderr) => {
        if (error) { resolve({ error: String(stderr || stdout || error.message).trim() }); return; }
        try {
          const parsed = JSON.parse(stdout);
          resolve({ decision: parsed.decision || 'no-match', matched: (parsed.matchedRules || []).length });
        } catch { resolve({ error: `unparseable output: ${stdout}` }); }
      });
  });
}

async function decisionsFor(rows, width = 4) {
  const answers = new Array(rows.length);
  let next = 0;
  await Promise.all(Array.from({ length: width }, async () => {
    while (next < rows.length) { const index = next++; answers[index] = await decisionFor(rows[index][1]); }
  }));
  return answers;
}

const ARGV_PREFIX = 'Codex stores argv prefix rules.';
const WRAPPER = 'a permission\nfor an inner tool does not automatically approve its wrapper or a script file.';
const VAR_PREFIX = 'The Claude generalizer strips `VAR=value <cmd>` prefixes. For Codex,\n  verify the actual shell invocation before expecting a prefix rule to cover it.';
const BARE_NAME = 'Call executables by bare name.';
const VERIFY = 'Verify the actual invocation with Codex;';

// [guidance sentence, argv, decision Codex must return, why]
const MATRIX = [
  [ARGV_PREFIX, ['git', 'status'], 'allow', 'the rule covers its own prefix'],
  [ARGV_PREFIX, ['git', 'status', '--short'], 'allow', 'and every argument after it'],
  [ARGV_PREFIX, ['rg', '--files', 'src'], 'allow', 'a one-token prefix covers any arguments'],
  [ARGV_PREFIX, ['git', 'log'], 'no-match', 'a different second token is a different prefix'],
  [ARGV_PREFIX, ['git'], 'no-match', 'a shorter argv is not covered by a longer prefix'],
  [WRAPPER, ['bash', '-lc', 'git status'], 'no-match', 'bash wrapper'],
  [WRAPPER, ['sh', '-c', 'git status'], 'no-match', 'sh wrapper'],
  [WRAPPER, ['zsh', '-lc', 'git status'], 'no-match', 'zsh wrapper'],
  [WRAPPER, ['pwsh', '-NoProfile', '-Command', 'git status'], 'no-match', 'PowerShell 7 wrapper'],
  [WRAPPER, ['powershell', '-Command', 'git status'], 'no-match', 'Windows PowerShell wrapper'],
  [WRAPPER, ['cmd', '/c', 'git status'], 'no-match', 'cmd.exe wrapper'],
  [WRAPPER, ['env', 'git', 'status'], 'no-match', 'env as a launcher is a wrapper too'],
  [WRAPPER, ['./run-gate.ps1'], 'no-match', 'a script file needs its own rule'],
  [WRAPPER, ['pwsh', '-File', 'run-gate.ps1'], 'no-match', 'and so does its host invocation'],
  [WRAPPER, ['bash', 'build.sh'], 'no-match', 'a POSIX script through its interpreter'],
  [VAR_PREFIX, ['GIT_PAGER=cat', 'git', 'status'], 'no-match', 'the checker does not strip an assignment prefix'],
  [BARE_NAME, ['/usr/bin/git', 'status'], 'no-match', 'an absolute POSIX path is not the bare name'],
  [BARE_NAME, ['C:\\Program Files\\Git\\cmd\\git.exe', 'status'], 'no-match', 'nor is an absolute Windows path'],
  [VERIFY, ['bash', '-lc', 'git status && rg x'], 'no-match',
    'the checker never splits a wrapped chain, even of allowed commands; the runtime may (wrapper runtime matrix)'],
  [VERIFY, ['git', 'status', '&&', 'rm', 'x'], 'allow',
    'a chain passed as argv TOKENS is just trailing arguments to the first prefix, so check each command, not the line'],
];

test('every guidance sentence the matrix quotes is still in the emitted body', () => {
  const body = GUIDANCE_BODY.replace(/\r\n/g, '\n');
  for (const sentence of new Set(MATRIX.map(([claim]) => claim))) {
    assert.ok(body.includes(sentence), `the guidance no longer says: ${JSON.stringify(sentence)} -- revisit this matrix`);
  }
  assert.match(body, /Codex can split simple shell chains before checking argv prefix rules/,
    'the runtime-only claim this file defers to scripts/check-codex-wrapper-runtime.js is still made');
});

test('a CI leg that provisions Codex really reaches it', { skip: REQUIRED ? false : 'ACOLYTE_REQUIRE_CODEX is not set' }, () => {
  assert.ok(CODEX_VERSION, `ACOLYTE_REQUIRE_CODEX=${REQUIRED} but no codex binary was reachable: the matrix would have skipped`);
  assert.equal(CODEX_VERSION, `codex-cli ${REQUIRED}`, 'the reachable codex is the pinned one');
});

test('Codex decides each shell spelling the way the guidance says it does', { skip }, async (t) => {
  const differences = [];
  const answers = await decisionsFor(MATRIX);
  for (const [index, [claim, argv, expected, why]] of MATRIX.entries()) {
    const answer = answers[index];
    assert.equal(answer.error, undefined, `${JSON.stringify(argv)}: ${answer.error}`);
    if (answer.decision !== expected) {
      differences.push(`${JSON.stringify(argv)}: Codex said ${answer.decision}, guidance implies ${expected} (${why}; "${claim.split('\n')[0]}")`);
    }
  }
  assert.deepEqual(differences, [], `${differences.length} of ${MATRIX.length} rows contradict the guidance`);
  t.diagnostic(`WITNESS ${MATRIX.length} shell spellings checked against ${CODEX_VERSION}`);
});

// The control. A matrix whose rules file did not load would answer "no-match"
// for every wrapper row and look like agreement; the allow rows above already
// guard that, and this proves the checker is reading THIS file at all.
test('the matrix rules file is the one Codex evaluated', { skip }, () => {
  const result = codex(['execpolicy', 'check', '--rules', RULES, '--', 'git', 'status']);
  assert.equal(result.status, 0, result.stderr);
  const parsed = JSON.parse(result.stdout);
  assert.deepEqual(parsed.matchedRules.map((rule) => rule.prefixRuleMatch?.matchedPrefix), [['git', 'status']]);
});
