#!/usr/bin/env node
'use strict';

// Which shell spellings a fresh Codex process lets a prefix rule cover, at RUNTIME.
//
//   node scripts/check-codex-wrapper-runtime.js --extension-dir <source-or-staged-root>
//     [--codex <executable>] [--only <case,case>] [--mutation empty-rules]
//
// WHY A RUNTIME CHECK AND NOT `codex execpolicy check` (2026-10-13). The shell
// guidance (src/agent-guidance.js GUIDANCE_BODY) claims Codex "can split simple
// shell chains before checking argv prefix rules", while "complex shell syntax,
// including expansions and redirections, may leave the whole wrapper as the
// checked command", and that "a permission for an inner tool does not
// automatically approve its wrapper". `codex execpolicy check` cannot test the
// first two: measured on codex-cli 0.161.0 it matches raw argv only and never
// unwraps a shell, so `bash -lc "git status"` gets no match from a `git status`
// rule there (test/codex-guidance-matrix.test.js pins that layer). Splitting
// happens in the runtime's approval path, so the honest witness is a real turn:
// a scripted loopback responder asks a fresh app-server to run each spelling and
// the case records whether Codex asked for approval and what actually executed.
//
// The case list follows the host's default shell: PowerShell spellings on
// Windows (where Codex 0.161.0 picked pwsh 7), POSIX spellings elsewhere
// (`VAR=value cmd`, `bash -c`, `sh -c`). On Windows two extra OBSERVE cases name
// `shell: "bash"` explicitly; the guidance makes no claim about that, so they
// are recorded and never counted.
//
// Every case runs harmless fixtures inside an isolated workspace. Approval
// requests are DECLINED, so a case that prompts executes nothing; the shared
// execution log is the witness for what did run. Scripted loopback provider
// and isolated profile from check-codex-runtime.js: no inference, credentials,
// real profile or VS Code UI.
//
// `--mutation empty-rules` writes an empty rules file. Every `allow` case must
// then measure `prompt`, so the run fails: the control that shows a green run
// depends on the rules rather than on Codex never asking.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { createRuntimeContext, runtimeCase } = require('./check-codex-runtime');

const BOUNDARY = 'Fresh Codex app-server per case, isolated profile, scripted loopback responder, harmless fixtures; approvals declined. No inference, credentials, real profile, or VS Code UI.';
// The provider credentials scrubbed from the Codex this launches: the one shared list (2026-10-14).
const { PROVIDER_CREDENTIAL_ENV: SECRET_ENV } = require('./check-codex-runtime');
const ENV_KEYS = ['HOME', 'USERPROFILE', 'CODEX_HOME', ...SECRET_ENV];

function parseArgs(argv) {
  const result = {};
  for (let i = 0; i < argv.length; i += 2) {
    assert.ok(['--extension-dir', '--codex', '--only', '--mutation'].includes(argv[i]) && argv[i + 1],
      'usage: check-codex-wrapper-runtime.js --extension-dir path [--codex executable] [--only case,case] [--mutation empty-rules]');
    result[argv[i]] = argv[i + 1];
  }
  assert.ok(result['--extension-dir'], '--extension-dir must name the subject');
  assert.ok(!result['--mutation'] || result['--mutation'] === 'empty-rules', 'unknown mutation');
  return result;
}

// A and B are allowed by their own rules; C has no rule. `expected` is what the
// guidance text implies at runtime, written from the claims and not from a run;
// `measured` is recorded beside it. `claim` names the guidance being tested.
// `observe` cases are recorded host facts that the guidance makes no claim
// about; they are printed and kept in the evidence but never counted.
const SPLIT = 'Codex can split simple shell chains';
const NEW = 'the cost lands when a chain needs a new approval';
const REDIRECT = 'redirections may leave the whole wrapper as the checked command';
const EXPAND = 'expansions may leave the whole wrapper as the checked command';
const WRAPPER = 'an inner-tool rule does not approve its wrapper';
function cases(platform, [a, b, c], workspace, extra) {
  const common = [
    { name: 'single-allowed', command: `${a} x`, expected: 'allow', claim: 'control: a prefix rule covers its own argv' },
    { name: 'single-unapproved', command: `${c} z`, expected: 'prompt', claim: 'control: no rule, so it prompts' },
    { name: 'and-chain-both-allowed', command: `${a} x && ${b} y`, expected: 'allow', claim: SPLIT },
    { name: 'semicolon-chain-both-allowed', command: `${a} x; ${b} y`, expected: 'allow', claim: SPLIT },
    { name: 'pipe-both-allowed', command: `${a} x | ${b} y`, expected: 'allow', claim: SPLIT },
    { name: 'and-chain-one-unapproved', command: `${a} x && ${c} z`, expected: 'prompt', claim: NEW },
    { name: 'redirection', command: `${a} x > out.txt`, expected: 'prompt', claim: REDIRECT },
    { name: 'subexpression', command: `${a} $(${b} y)`, expected: 'prompt', claim: EXPAND },
  ];
  if (platform === 'win32') return [...common,
    { name: 'env-assignment-then-command', command: `$env:ACOLYTE_FIXTURE='1'; ${a} x`, expected: 'prompt', claim: 'verify before expecting an environment prefix to be stripped' },
    { name: 'cmd-c-wrapper', command: `cmd /c ${a} x`, expected: 'prompt', claim: WRAPPER },
    { name: 'pwsh-command-wrapper', command: `pwsh -NoProfile -Command "${a} x"`, expected: 'prompt', claim: WRAPPER },
    { name: 'powershell-command-wrapper', command: `powershell -NoProfile -Command "${a} x"`, expected: 'prompt', claim: WRAPPER },
    { name: 'absolute-path', command: `& "${path.join(workspace, a)}" x`, expected: 'prompt', claim: 'call executables by bare name' },
    // Measured 2026-10-13: an exec_command that names `shell: "bash"` on
    // Windows runs Git Bash by absolute path, and no prefix rule applied to it,
    // not even to the single-command control. Recorded, not claimed.
    ...(extra.bashFixtures ? [
      { name: 'explicit-bash-single', command: `${extra.bashFixtures[0]} x`, expected: 'observe', shell: 'bash', claim: 'host fact: explicit Git Bash on Windows' },
      { name: 'explicit-bash-and-chain', command: `${extra.bashFixtures[0]} x && ${extra.bashFixtures[1]} y`, expected: 'observe', shell: 'bash', claim: 'host fact: explicit Git Bash on Windows' },
    ] : []),
  ];
  return [...common,
    { name: 'var-prefix', command: `ACOLYTE_FIXTURE=1 ${a} x`, expected: 'prompt', claim: 'verify before expecting VAR=value prefixes to be stripped' },
    { name: 'bash-c-wrapper', command: `bash -c "${a} x"`, expected: 'prompt', claim: WRAPPER },
    { name: 'sh-c-wrapper', command: `sh -c "${a} x"`, expected: 'prompt', claim: WRAPPER },
    { name: 'absolute-path', command: `"${path.join(workspace, a)}" x`, expected: 'prompt', claim: 'call executables by bare name' },
  ];
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  const windows = process.platform === 'win32';
  const extension = path.resolve(options['--extension-dir']);
  const out = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-wrapper-runtime-'));
  const home = path.join(out, 'home');
  const codexHome = path.join(home, '.codex');
  const workspace = path.join(out, 'workspace');
  const reportPath = path.join(out, 'evidence.json');
  const report = { status: 'running', boundary: BOUNDARY, out, extension, platform: process.platform,
    mutation: options['--mutation'] || null, startedAt: new Date().toISOString(), cases: [], observations: [], skipped: [] };
  const save = () => fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n');
  const originalEnv = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));
  save();
  try {
    for (const directory of [codexHome, workspace, path.join(home, '.claude')]) fs.mkdirSync(directory, { recursive: true });
    Object.assign(process.env, { HOME: home, USERPROFILE: home, CODEX_HOME: codexHome });
    for (const key of SECRET_ENV) delete process.env[key];
    assert.equal(os.homedir(), home, 'isolate home before loading any subject module');
    const { commandLaunch, resolveExecutable } = require(path.join(extension, 'src', 'exec-resolve.js'));
    const executable = options['--codex'] || 'codex';
    const version = commandLaunch(executable, ['--version']);
    assert.ok(version.resolved, 'Codex executable is not reachable');
    report.codexVersion = String(spawnSync(version.file, version.args, { ...version.options, windowsHide: true, encoding: 'utf8', timeout: 10000 }).stdout || '').trim();
    assert.match(report.codexVersion, /^codex-cli \S+$/, 'record exact CLI version');
    report.bash = windows ? resolveExecutable('bash') : null;
    const suffix = crypto.randomBytes(4).toString('hex');
    const witness = `acolyte-wrap-witness-${suffix}`;
    const log = path.join(workspace, 'execution-witness.log');
    // Bare-name fixtures the runtime finds on PATH (createRuntimeContext puts
    // the workspace first): .cmd on Windows, executable shebang scripts
    // elsewhere and for the explicit-Git-Bash observations on Windows.
    const sh = ['a', 'b', 'c'].map((letter) => `acolyte-wrap-${letter}-${suffix}${windows ? '.sh' : ''}`);
    const cmd = windows ? ['a', 'b', 'c'].map((letter) => `acolyte-wrap-${letter}-${suffix}.cmd`) : sh;
    if (windows) {
      for (const [index, name] of cmd.entries()) {
        fs.writeFileSync(path.join(workspace, name),
          `@echo off\r\necho ${'abc'[index]}>>"%~dp0execution-witness.log"\r\necho ${witness}-${'abc'[index]}\r\n`);
      }
    }
    for (const [index, name] of sh.entries()) {
      fs.writeFileSync(path.join(workspace, name),
        `#!/bin/sh\necho ${'abc'[index]} >> "$(dirname "$0")/execution-witness.log"\necho ${witness}-${'abc'[index]}\n`, { mode: 0o755 });
    }
    const user = `acolyte-wrap-user-${suffix}`;
    fs.writeFileSync(path.join(codexHome, 'AGENTS.md'), `# Isolated wrapper fixture\n${user}\n`);
    const rules = path.join(codexHome, 'rules', 'fixture.rules');
    fs.mkdirSync(path.dirname(rules), { recursive: true });
    const allowed = [...new Set([cmd[0], sh[0]])].map((name) => [name, 'x'])
      .concat([...new Set([cmd[1], sh[1]])].map((name) => [name, 'y']));
    fs.writeFileSync(rules, report.mutation === 'empty-rules' ? '# MUTATION: no rules\n'
      : allowed.map((pattern) => `prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = "allow")\n`).join(''));
    report.fixture = { rules: fs.readFileSync(rules, 'utf8'), names: cmd };
    const selected = options['--only'] ? new Set(options['--only'].split(',')) : null;
    const plan = cases(process.platform, cmd, workspace, { bashFixtures: windows && report.bash ? sh : null })
      .filter((item) => !selected || selected.has(item.name));
    if (windows && !report.bash) report.skipped.push({ name: 'explicit-bash-*', reason: 'no bash executable is reachable' });
    console.log(BOUNDARY);
    console.log(`Subject ${extension}; ${report.codexVersion}; ${process.platform}; evidence ${reportPath}`);
    if (report.mutation) console.log(`MUTATION ACTIVE: ${report.mutation}; every allow case is expected to DIFFER and the run to fail.`);
    for (const item of plan) {
      const context = createRuntimeContext({ extensionDir: extension, home, codexHome, workspace,
        codexExecutable: executable, shellWitness: witness, approvalDecision: 'decline',
        instructionWitnesses: { user, gate: `absent-gate-${suffix}` } });
      const before = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
      const record = { ...item };
      (item.expected === 'observe' ? report.observations : report.cases).push(record);
      try {
        const result = await runtimeCase({ ...context, commandLine: item.command, shellBinary: item.shell }, item.name, '', false);
        const after = fs.existsSync(log) ? fs.readFileSync(log, 'utf8') : '';
        record.approvals = result.approvals;
        record.shellTool = result.shellTool;
        record.status = result.commandItems[0]?.status;
        record.exitCode = result.commandItems[0]?.exitCode;
        record.runtimeCommand = result.commandItems[0]?.command ?? null;
        record.executed = after.slice(before.length).split(/\r?\n/).filter(Boolean);
        record.measured = result.approvals === 0 ? 'allow' : 'prompt';
        // An allow that executed nothing, or a prompt that executed anything,
        // is not the outcome it looks like: both have to hold together.
        record.consistent = record.measured === 'allow'
          ? record.status === 'completed' && record.exitCode === 0 && record.executed.length > 0
          : record.executed.length === 0;
        record.agrees = item.expected === 'observe' ? null : record.consistent && record.measured === item.expected;
      } catch (error) {
        record.error = String(error.message || error);
        record.agrees = item.expected === 'observe' ? null : false;
      }
      save();
      const label = item.expected === 'observe' ? 'OBSERVE' : record.agrees ? 'AGREE' : record.error ? 'ERROR' : 'DIFFER';
      console.log(`${label} ${item.name}: expected ${item.expected}, measured ${record.measured ?? '-'}`
        + `, approvals=${record.approvals ?? '-'}, executed=[${(record.executed || []).join(',')}]${record.error ? ` (${record.error})` : ''}`);
    }
    report.agreed = report.cases.filter((item) => item.agrees).length;
    report.status = report.cases.length > 0 && report.agreed === report.cases.length ? 'passed' : 'failed';
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    report.status = 'failed'; report.failure = String(error.stack || error); process.exitCode = 1;
  } finally {
    for (const [key, value] of Object.entries(originalEnv)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
    report.finishedAt = new Date().toISOString(); save();
    console.log(`${report.status.toUpperCase()}: ${report.agreed ?? 0}/${report.cases.length} cases agree with the guidance`
      + `, ${report.observations.length} host observations${report.skipped.length ? `, ${report.skipped.length} skipped` : ''}; ${reportPath}`);
    if (report.failure) console.error(report.failure);
  }
}

if (require.main === module) main().catch((error) => { console.error(error.stack || error); process.exitCode = 1; });
