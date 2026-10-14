#!/usr/bin/env node
'use strict';

// Real Codex code-mode `exec` cells, completed directly or continued by `wait`,
// using a scripted loopback provider. No inference or provider credentials.
//
//   node scripts/check-codex-code-mode-runtime.js --extension-dir <source-or-staged-root>
//     [--write-fixture <path>] [--write-continuity-fixture <path>] [--write-refusal-fixture <path>] [--case <name>]...
//
// WHY THIS EXISTS (2026-10-13). The history parser reads a custom
// `functions.exec` cell whose body calls `tools.exec_command(...)`, and the
// September 28 record left "custom functions.exec/functions.wait continuation"
// outside its proof because no actual continued cell had ever been observed.
// Codex 0.161.0 exposes `exec` (a custom, grammar-format tool) and `wait` (a
// function tool) when the fixture enables `code_mode`, so a scripted responder
// can make a fresh app-server emit both shapes. This records what the rollout
// contains and what the named subject's parser concludes, cell by cell.
//
// What it asserted first was the safety property alone: a cell is credited with
// its true terminal outcome or left `unknown`, never the opposite one. Since
// the parser joins a `wait` result back to the cell it names (2026-10-13), it
// asserts the exact outcome instead: completed and continued cells carry their
// own, a cell continued across a wait that yields again included, and a
// terminated cell carries none. A parser without the join fails here, on every
// continued cell. The observed per-cell verdicts are printed and recorded.
//
// `--write-fixture` writes a sanitized copy of the one-session sequence rollout
// (every cell shape in real order and real cell-ID allocation) for
// test/codex-code-mode-history.test.js. Paths, ids and timestamps are replaced;
// no instructions, environment or machine detail is carried over.
//
// The CONTINUITY cases (2026-10-13) drive cells across turns, resumes and forks
// -- several turns, app-server restarts, thread/resume, thread/fork and
// `codex exec resume` -- and assert what each measured (see CONTINUITY_CASES).
// `--write-continuity-fixture` writes their rollouts, sanitized the same way,
// for test/codex-code-mode-continuity.test.js; it needs every continuity case.
// The REFUSAL cases (2026-10-13) put a nested command Codex refused before it ran
// beside one that ran and failed, in a cell and as a direct call (REFUSAL_CASES);
// `--write-refusal-fixture` writes their rollouts the same way, for
// test/codex-code-mode-refusal.test.js, and needs every refusal case.
// `--case <name>` (repeatable) runs only the named cases.
//
// code_mode is enabled ONLY in this fixture's temporary CODEX_HOME. Nothing
// here implies the feature is on, or stable, in anybody's real profile.
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const os = require('node:os');
const readline = require('node:readline');
const { spawn, spawnSync } = require('node:child_process');

// The provider credentials scrubbed from the Codex this launches: the one shared list (2026-10-14).
const { PROVIDER_CREDENTIAL_ENV: SECRET_ENV } = require('./check-codex-runtime');
const WITNESS = 'acolyte-code-mode-witness';
const args = process.argv.slice(2);
for (let i = 0; i < args.length; i += 2) {
  assert.ok(['--extension-dir', '--write-fixture', '--write-continuity-fixture', '--write-refusal-fixture', '--case'].includes(args[i]) && args[i + 1],
    'usage: check-codex-code-mode-runtime.js --extension-dir <source-or-staged-root> [--write-fixture <path>]'
    + ' [--write-continuity-fixture <path>] [--write-refusal-fixture <path>] [--case <name>]...');
}
const option = (name) => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
// `--case` (repeatable) runs only the named cases; without it, every case runs.
const selectedCases = args.filter((value, index) => index % 2 === 1 && args[index - 1] === '--case');
assert.ok(option('--extension-dir'), '--extension-dir must name the subject');
const subject = path.resolve(option('--extension-dir'));
const { commandLaunch } = require(path.join(subject, 'src/exec-resolve'));
const { parseCodexJsonl } = require(path.join(subject, 'src/history-adapters'));
const { rolloutFor, isolateWorkspaceInstructions, assertNoForeignInstructions } = require('./check-codex-runtime');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-code-mode-'));
const digest = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const evidence = { boundary: 'Isolated real Codex app-server with code_mode enabled only in a temporary CODEX_HOME; scripted loopback provider, no inference or credentials; fixture-only rollouts.', root, cases: [] };

// A cell either finishes inside its own yield window (`complete`) or yields
// first and is finished by `wait` (`continued`). Exit 7 is a deliberate
// nonzero; the shell may report it as another nonzero code, which is why the
// expectation is a status rather than a number.
//
// Two more shapes, added 2026-10-13 with the parser's wait join. `rewaited`:
// the command outlasts the first wait's window, so a wait itself yields again
// ("If the cell is still running, `wait` may yield again with the same
// `cell_id`", 0.161.0's own tool description) and a later wait completes it.
// 12 s against 5 s waits leaves at least one repeated yield even if Codex
// clamps the wait to 10 s as it clamps exec_command's yield on Windows.
// `terminated`: the first wait passes `terminate: true` ("stops the running
// cell"), so the cell has no outcome at all and must never be credited; its
// command would have exited 0, which is what a reader that credited the
// termination result as a completion would wrongly claim.
const COMPLETE_SUCCESS = { exitCode: 0, delayMs: 10, cellYieldMs: 25000, expected: 'success', continued: false };
const COMPLETE_FAILED = { exitCode: 7, delayMs: 10, cellYieldMs: 25000, expected: 'failed', continued: false };
const CONTINUED_SUCCESS = { exitCode: 0, delayMs: 4000, cellYieldMs: 500, expected: 'success', continued: true };
const CONTINUED_FAILED = { exitCode: 7, delayMs: 4000, cellYieldMs: 500, expected: 'failed', continued: true };
const REWAITED_SUCCESS = { exitCode: 0, delayMs: 12000, cellYieldMs: 500, waitYieldMs: 5000, expected: 'success', continued: true, rewaited: true };
const TERMINATED = { exitCode: 0, delayMs: 20000, cellYieldMs: 500, expected: 'unknown', continued: true, terminate: true };

// A case is a list of steps (2026-10-13, for the continuity cases below):
//   { start: 'A' }                  thread/start, remembered as thread A
//   { turn: 'A', cells, ... }       one turn on thread A's app-server thread:
//       waitFor: n                  its first call is a wait for the ID that cell
//                                   n (1-based, from an earlier turn) was allocated
//       waitAfter: n, waitAfterId   after its own cells, a wait for cell n's ID
//                                   (or waitAfterId, for a cell that never yielded)
//       overrides: {...}            turn/start's own setting overrides
//   { restart: true }               end this app-server process, start a new one
//   { resume: 'A', bare }           thread/resume A in the current process (`bare`:
//                                   the thread id alone, no setting overrides)
//   { unsubscribe: 'A' }            thread/unsubscribe A
//   { fork: 'A', as: 'B' }          thread/fork A, remembered as thread B
//   { exec: 'A', cells }            one turn as its own `codex exec` process,
//   { execResume: 'A', cells }      or `codex exec resume <A>` (waitFor as above)
// Cells are numbered across the whole case (call_cell_1..N) in step order. A
// one-turn case is [{ start }, { turn }], whose provider exchange is the one
// this harness has always made, request for request (the sequence fixture it
// writes is byte-identical to the one written before steps existed).
const oneTurn = (cells) => [{ start: 'A' }, { turn: 'A', cells }];
const CASES = [
  ['complete-success', oneTurn([COMPLETE_SUCCESS])],
  ['complete-failed', oneTurn([COMPLETE_FAILED])],
  ['continued-success', oneTurn([CONTINUED_SUCCESS])],
  ['continued-failed', oneTurn([CONTINUED_FAILED])],
  ['rewaited-success', oneTurn([REWAITED_SUCCESS])],
  ['terminated', oneTurn([TERMINATED])],
  // One session, every shape in sequence: real ordering and real cell-ID
  // allocation for the sanitized fixture, and the parser's view of a session
  // that mixes them. The first four are the original fixture's, in its order.
  ['sequence', oneTurn([COMPLETE_SUCCESS, COMPLETE_FAILED, CONTINUED_SUCCESS, CONTINUED_FAILED, REWAITED_SUCCESS, TERMINATED])],
];

// CONTINUITY CASES (2026-10-13). What happens to code-mode cell IDs and to
// running cells across a turn boundary, a resume (into the same app-server
// process, into a new one, and through `codex exec resume`) and thread/fork.
// Only a yield reveals the ID a cell was allocated ("Script running with cell
// ID N"), so the cells here yield, except where a cell completing silently is
// the point. `leaveOpen` ends its turn straight after the cell's own yield, with
// no wait, so a later turn, a resumed thread or a fork can wait on it.
//
// Each case states what was measured on codex-cli 0.161.0 (Windows), and the
// harness asserts it, so a later build that moves any of it fails here:
//   allocated  the ID each cell was allocated, in cell order (null: no yield)
//   waits      what each wait for an EARLIER cell returned: 'completed' (the
//              cell was still there) or 'not-found' (the runtime's own "Script
//              failed" / "Script error: exec cell N not found")
//   reloads    event_msg/thread_settings_applied records per thread's rollout
//   forkedFrom the thread a fork's session_meta names as its parent
// Every thread has exactly one rollout file with one session_meta, and every
// cell is observed in its own thread's file and no other (a fork copies none of
// its parent's items). Each cell's `expected` is the parser's exact verdict: the
// true outcome, or `unknown` where the cell has none (it was killed with its
// runtime) or the join withholds by rule (two open cells under one key).
const PROBE = { exitCode: 0, delayMs: 3000, cellYieldMs: 500, expected: 'success', continued: true };
const leftOpen = (expected) => ({ exitCode: 0, delayMs: 6000, cellYieldMs: 500, expected, continued: true, leaveOpen: true });
const CONTINUITY_CASES = [
  // A running cell survives a turn boundary in one process; IDs continue.
  ['across-turns', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('success')] }, { turn: 'A', waitFor: 1, cells: [PROBE] }],
    { allocated: ['1', '2'], waits: ['completed'] }],
  // So does it across a resume inside the same process, also after thread/unsubscribe.
  ['resumed-same-process', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('success')] }, { resume: 'A' },
    { turn: 'A', waitFor: 1, cells: [PROBE] }], { allocated: ['1', '2'], waits: ['completed'] }],
  ['unsubscribed-resume', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('success')] }, { unsubscribe: 'A' }, { resume: 'A' },
    { turn: 'A', waitFor: 1, cells: [PROBE] }], { allocated: ['1', '2'], waits: ['completed'] }],
  // A resume into a NEW process appends to the same file, restarts allocation
  // at 1 and writes thread_settings_applied, with or without overrides.
  ['resumed', [{ start: 'A' }, { turn: 'A', cells: [PROBE, PROBE] }, { restart: true }, { resume: 'A' }, { turn: 'A', cells: [PROBE] }],
    { allocated: ['1', '2', '1'], reloads: { A: 1 } }],
  ['resumed-bare', [{ start: 'A' }, { turn: 'A', cells: [PROBE] }, { restart: true }, { resume: 'A', bare: true }, { turn: 'A', cells: [PROBE] }],
    { allocated: ['1', '1'], reloads: { A: 1 } }],
  // A cell left running at that restart is gone: the wait for it is "not
  // found" (the defect: the parser read that as the cell's failure), and the new
  // runtime's next cell takes its ID. The old cell has no outcome.
  ['resumed-open-cell', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('unknown')] }, { restart: true }, { resume: 'A' },
    { turn: 'A', waitFor: 1, cells: [PROBE] }], { allocated: ['1', '1'], waits: ['not-found'], reloads: { A: 1 } }],
  // The same, with the ID handed to a cell that completes without yielding
  // before anything waits on the old one: the runtime does not keep finished
  // cells, so the wait is still "not found", never the new cell's result.
  ['resumed-reallocated', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('unknown')] }, { restart: true }, { resume: 'A' },
    { turn: 'A', cells: [COMPLETE_SUCCESS], waitAfter: 1 }], { allocated: ['1', null], waits: ['not-found'], reloads: { A: 1 } }],
  // And with the ID handed to a cell that DOES yield before anything waits on
  // the old one: two open cells, one key, and the join withholds both by rule.
  // The new cell really succeeded; this is the coverage that rule gives up.
  ['resumed-reused-id', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('unknown')] }, { restart: true }, { resume: 'A' },
    { turn: 'A', cells: [{ ...PROBE, expected: 'unknown' }] }], { allocated: ['1', '1'], reloads: { A: 1 } }],
  // `codex exec resume` behaves as an app-server resume into a new process.
  ['exec-resumed', [{ exec: 'A', cells: [PROBE, PROBE] }, { execResume: 'A', cells: [PROBE] }],
    { allocated: ['1', '2', '1'], reloads: { A: 2 } }],
  ['exec-resumed-open-cell', [{ exec: 'A', cells: [leftOpen('unknown')] }, { execResume: 'A', waitFor: 1, cells: [PROBE] }],
    { allocated: ['1', '1'], waits: ['not-found'], reloads: { A: 2 } }],
  // A fork is a new file allocating from 1; the parent continues its own sequence.
  ['forked', [{ start: 'A' }, { turn: 'A', cells: [PROBE, PROBE] }, { fork: 'A', as: 'B' }, { turn: 'B', cells: [PROBE] },
    { turn: 'A', cells: [PROBE] }], { allocated: ['1', '2', '1', '3'], reloads: { B: 1 }, forkedFrom: { B: 'A' } }],
  ['forked-open-cell', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('unknown')] }, { fork: 'A', as: 'B' },
    { turn: 'B', waitFor: 1, cells: [PROBE] }], { allocated: ['1', '1'], waits: ['not-found'], reloads: { B: 1 }, forkedFrom: { B: 'A' } }],
  // thread_settings_applied without a reload: a same-process turn/start with
  // setting overrides writes it, and the cell running across it survives. This
  // is why the parser does not treat that record as a resume epoch.
  ['turn-overrides', [{ start: 'A' }, { turn: 'A', cells: [leftOpen('success')] },
    { turn: 'A', waitFor: 1, cells: [PROBE], overrides: { model: 'acolyte-code-mode-fixture-b', approvalPolicy: 'untrusted' } }],
    { allocated: ['1', '2'], waits: ['completed'], reloads: { A: 1 } }],
  // "Not found" for a cell that completed in its own window: no cell is open,
  // so nothing is closed, and the completed cell keeps its own outcome.
  ['completed-then-waited', [{ start: 'A' }, { turn: 'A', cells: [COMPLETE_SUCCESS], waitAfter: 1, waitAfterId: '1' }],
    { allocated: [null], waits: ['not-found'] }],
  // A SCRIPT that throws the runtime's own words, after its nested command
  // succeeded and without printing it: how the runtime writes a thrown value,
  // which the parser's not-found shape has to be told apart from. A thrown
  // Error is written "Script error:\nError: exec cell 1 not found" plus a stack
  // line (the script module, line 2, column 7), which the shape excludes, so the
  // cell stays failed, as any script failure does. A thrown bare STRING is written exactly as the
  // runtime's own not-found, so that cell reads as stopped: withheld, never
  // credited. Only the model's own code can write that part, naming its own cell.
  ['thrown-not-found', [{ start: 'A' }, { turn: 'A', cells: [{ ...PROBE, expected: 'failed', tail: 'throw new Error("exec cell 1 not found");' }] }],
    { allocated: ['1'] }],
  ['thrown-string', [{ start: 'A' }, { turn: 'A', cells: [{ ...PROBE, expected: 'unknown', tail: 'throw "exec cell 1 not found";' }] }],
    { allocated: ['1'] }],
];

// REFUSAL CASES (2026-10-13). A nested command that Codex's approval layer
// refused never ran, so it is no evidence either way; one that ran and exited
// nonzero is a failure. Each case puts the two side by side, in a cell and as
// a direct exec_command call, because the parser's rule for a refused CELL is
// to mirror what it already does with a refused DIRECT call (it withholds it).
// Two refusals are measured:
//   never     `codex exec` (approval never, full access) with an escalation
//             request: refused outright, with no prompt at all
//   declined  an app-server prompt, answered `decline`
// `declined-after-yield` answers the prompt late, so the cell yields first and
// the refusal reaches the rollout as a wait's result, not the cell's own.
// Each cell's `refused` names the refusal it gets (null: its command runs), and
// the harness asserts the measured text exactly (REFUSALS below), that a refused
// command never ran and every other did (`marker`), and the parser's verdict.
const call = (exitCode, expected, extra = {}) => ({ exitCode, delayMs: 10, cellYieldMs: 25000, expected, continued: false,
  marker: true, refused: null, ...extra });
const REFUSAL_CASES = [
  ['refused-never', [{ exec: 'A', cells: [
    call(0, 'unknown', { escalate: true, refused: 'never' }),
    call(7, 'failed'),
    call(0, 'unknown', { escalate: true, direct: true, refused: 'never' }),
    call(7, 'failed', { direct: true }),
  ] }]],
  ['declined', [{ start: 'A' }, { turn: 'A', cells: [
    call(0, 'unknown', { decline: true, refused: 'declined' }),
    call(7, 'failed'),
    call(0, 'unknown', { direct: true, decline: true, refused: 'declined' }),
    call(7, 'failed', { direct: true }),
  ] }]],
  ['declined-after-yield', [{ start: 'A' }, { turn: 'A', cells: [
    call(0, 'unknown', { cellYieldMs: 500, continued: true, decline: true, approvalDelayMs: 3000, refused: 'declined' }),
    call(7, 'failed', { delayMs: 4000, cellYieldMs: 500, continued: true }),
  ] }]],
];
// What each refusal was measured to write, codex-cli 0.161.0, 2026-10-13. One
// text per refusal: a direct call's whole output is it, and a cell's result is a
// "Script failed" head with nothing under Output: beside "Script error:\n" plus
// the SAME text -- the nested tool call fails with the message the direct call
// returns. The parser recognises a refused cell by exactly these
// (src/history-adapters.js, CODE_MODE_REFUSALS); a build that rewords one fails
// here before it can quietly turn a refusal back into a failure.
const REFUSALS = {
  never: 'approval policy is Never; reject command \u2014 you cannot ask for escalated permissions if the approval policy is Never',
  declined: 'exec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\")" }',
};

function sse(res, item, id) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const event of [
    { type: 'response.created', response: { id, object: 'response', status: 'in_progress', output: [] } },
    { type: 'response.output_item.added', output_index: 0, item },
    { type: 'response.output_item.done', output_index: 0, item },
    { type: 'response.completed', response: { id, object: 'response', status: 'completed', output: [item], usage: { input_tokens: 1, output_tokens: 1, total_tokens: 2 } } },
  ]) res.write(`event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`);
  res.end();
}

function outputText(output) {
  if (typeof output === 'string') return output;
  if (Array.isArray(output)) return output.map((part) => (typeof part?.text === 'string' ? part.text : JSON.stringify(part))).join('\n');
  return JSON.stringify(output);
}

// Every rollout file Codex wrote for one thread id, in name order. A thread is
// expected to own exactly one, but the continuity cases are what measure that,
// so they list rather than assert.
function rolloutsFor(codexHome, threadId) {
  const pending = [path.join(codexHome, 'sessions')];
  const found = [];
  while (pending.length) {
    const directory = pending.pop();
    if (!fs.existsSync(directory)) continue;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const file = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(file);
      else if (entry.isFile() && entry.name.endsWith('.jsonl') && entry.name.includes(threadId)) found.push(file);
    }
  }
  return found.sort();
}

const CELL_RUNNING_RE = /Script running with cell ID\s+([A-Za-z0-9_-]+)/i;
const firstLine = (output) => outputText(output).replace(/\r\n/g, '\n').split('\n', 1)[0];

async function run(name, steps) {
  const dir = path.join(root, name), home = path.join(dir, 'home'), codexHome = path.join(home, '.codex'), workspace = path.join(dir, 'workspace');
  for (const target of [codexHome, workspace]) fs.mkdirSync(target, { recursive: true });
  // Workspace is its own project root, canary one level up (check-codex-runtime.js, 2026-10-13).
  isolateWorkspaceInstructions(workspace);
  const plan = [];
  // A turn runs on an app-server thread (`turn`) or as its own `codex exec`
  // process (`exec`, `execResume`); the label is the thread either way.
  const turnOf = (step) => step.turn ?? step.exec ?? step.execResume;
  const schedule = steps.map((step) => (!turnOf(step) ? step : { ...step, plan: (step.cells || []).map((cell) => {
    const index = plan.length;
    const script = path.join(workspace, `cell-${index + 1}.cjs`);
    // `marker` (the refusal cases): the script's first act is to create a file,
    // so whether the command RAN is read from disk afterwards, not inferred from
    // what Codex reported about it. Other cases keep their original script.
    const ranMarker = cell.marker ? path.join(workspace, `cell-${index + 1}.ran`) : null;
    fs.writeFileSync(script, `${ranMarker ? `require('node:fs').writeFileSync(${JSON.stringify(ranMarker)}, '');\n` : ''}`
      + `setTimeout(() => { console.log('${WITNESS}'); process.exit(${cell.exitCode}); }, ${cell.delayMs});\n`);
    // A plain string literal with forward slashes, so the parser's lexer, which
    // refuses variables, concatenation and escapes it cannot prove, can read it.
    const command = `node "${script.replace(/\\/g, '/')}"`;
    // Under `codex exec` (approval never, full access) an escalation request is
    // refused outright -- "you cannot ask for escalated permissions if the
    // approval policy is Never", measured 2026-10-13 -- and none is needed. A
    // refusal case's `escalate` cell asks anyway: that refusal is its subject.
    const escalate = !!step.turn || !!cell.escalate;
    const escalation = escalate ? 'sandbox_permissions: "require_escalated", justification: "Harmless isolated code-mode canary.", ' : '';
    const source = `// @exec: {"yield_time_ms": ${cell.cellYieldMs}, "max_output_tokens": 400}\n`
      + `const result = await tools.exec_command({ cmd: ${JSON.stringify(command)}, ${escalation}yield_time_ms: 30000 });\n`
      + `${cell.tail ?? 'text(result);'}\n`;
    // `direct` (the refusal cases): the same command as a plain exec_command
    // function call, outside any cell -- the shape whose declined outcome the
    // parser already withholds, measured beside the cell for parity.
    const direct = !cell.direct ? undefined : JSON.stringify({ cmd: command, ...(escalate
      ? { sandbox_permissions: 'require_escalated', justification: 'Harmless isolated code-mode canary.' } : {}), yield_time_ms: 10000 });
    const entry = { ...cell, callId: `call_cell_${index + 1}`, command, source, direct, ranMarker, thread: turnOf(step), via: step.turn ? 'app-server' : 'exec' };
    plan.push(entry);
    return entry;
  }) }));
  const turnCount = schedule.filter(turnOf).length;
  const byCall = new Map(plan.map((cell) => [cell.callId, cell]));
  const env = { ...process.env, HOME: home, USERPROFILE: home, CODEX_HOME: codexHome };
  for (const key of SECRET_ENV) delete env[key];
  const observed = { name, cells: plan.map(({ callId, expected, continued, rewaited, terminate, leaveOpen, thread, via, direct, decline, refused }) =>
      ({ callId, thread, via, expected, continued, rewaited: !!rewaited, terminate: !!terminate, leaveOpen: !!leaveOpen,
        ...(direct || decline || refused ? { direct: !!direct, decline: !!decline, refused: refused ?? null } : {}) })),
    requests: 0, approvals: [], decisions: [], calls: [], waits: [], events: [], steps: [], processes: 0 };
  evidence.cases.push(observed);
  const record = (callId) => observed.cells.find((entry) => entry.callId === callId);
  // `active` is the turn in progress; a provider request outside one is a failure.
  let proc = null, active = null, failure = null, timer;
  const fail = (error) => {
    failure ??= error;
    if (proc) { for (const item of proc.pending.values()) item.reject(error); proc.pending.clear(); }
    if (active) active.reject(error);
  };
  const server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (chunk) => chunks.push(chunk));
    req.on('end', () => {
      try {
        assert.equal(req.headers.authorization, undefined, 'fixture provider must receive no authorization header');
        assert.equal(req.headers['api-key'], undefined, 'fixture provider must receive no API key header');
        const raw = Buffer.concat(chunks).toString('utf8');
        assertNoForeignInstructions(raw, name);
        const body = JSON.parse(raw);
        observed.requests += 1;
        observed.canaryFreeRequests = observed.requests;
        assert.ok(observed.requests <= turnCount + plan.length * 6, 'unexpected extra provider requests');
        const turn = active;
        assert.ok(turn, 'a provider request arrived outside any turn');
        const fresh = turn.requests++ === 0;
        const outputs = body.input.filter((item) => ['function_call_output', 'custom_tool_call_output'].includes(item.type));
        // Within a turn the latest output is this turn's own. The first request of
        // a later turn carries the previous turn's last output, which decides
        // nothing here: a cell left running is resumed only by an explicit waitFor.
        const latest = fresh ? null : outputs[outputs.length - 1];
        if (fresh) {
          observed.catalog ??= body.tools.map((tool) => ({ type: tool.type, name: tool.name }));
          assert.ok(body.tools.some((tool) => tool.type === 'custom' && tool.name === 'exec'), 'code_mode exposes the custom exec tool');
          assert.ok(body.tools.some((tool) => tool.name === 'wait'), 'code_mode exposes wait');
        } else assert.ok(latest, 'every continuation request must carry real tool output');
        // What each wait returned, by its header line: the measured answer to
        // "does this cell still exist here".
        const answered = latest && observed.waits.find((wait) => wait.callId === latest.call_id);
        if (answered) Object.assign(answered, { resultHeader: firstLine(latest.output), resultText: outputText(latest.output).slice(0, 400) });
        const running = latest && CELL_RUNNING_RE.exec(outputText(latest.output));
        if (running && latest.type === 'custom_tool_call_output' && byCall.has(latest.call_id)) {
          const cell = byCall.get(latest.call_id);
          cell.allocated = running[1];
          record(cell.callId).allocated = running[1];
        }
        let item;
        const wait = (cell, cellId, terminate, extra = {}) => {
          const callId = `call_wait_${observed.requests}`;
          observed.waits.push({ after: latest ? latest.call_id : null, afterType: latest ? latest.type : null, cellId, cell: cell.callId, terminate, callId, ...extra });
          return { type: 'function_call', name: 'wait', call_id: callId, arguments: JSON.stringify(terminate
            ? { cell_id: cellId, terminate: true } : { cell_id: cellId, yield_time_ms: cell.waitYieldMs ?? 10000 }) };
        };
        if (fresh && turn.waitFor) {
          // A cell from an earlier turn, by the ID Codex allocated it then.
          const cell = plan[turn.waitFor - 1];
          assert.ok(cell && cell.allocated, `cell ${turn.waitFor} yielded in an earlier turn`);
          turn.waiting = cell;
          item = wait(cell, cell.allocated, false, { crossTurn: true });
        } else if (running) {
          // The running cell is the one whose own yield this is, or the one the
          // last wait was for: the next exec is only sent once it stops running.
          const cell = latest.type === 'custom_tool_call_output' ? byCall.get(latest.call_id) : turn.waiting;
          assert.ok(cell, 'a running output names a cell this case issued');
          if (cell.leaveOpen && latest.type === 'custom_tool_call_output') {
            // End the turn with the cell still running, for a later turn to wait on.
            item = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Leaving the isolated cell running.', annotations: [] }] };
          } else {
            turn.waiting = cell;
            const terminate = !!cell.terminate && !observed.waits.some((entry) => entry.cell === cell.callId && entry.terminate);
            item = wait(cell, running[1], terminate);
          }
        } else if (turn.next < turn.plan.length) {
          const cell = turn.plan[turn.next++];
          turn.waiting = null;
          item = cell.direct ? { type: 'function_call', name: 'exec_command', call_id: cell.callId, arguments: cell.direct }
            : { type: 'custom_tool_call', name: 'exec', call_id: cell.callId, input: cell.source };
        } else if (turn.waitAfter && !turn.waitedAfter) {
          // After this turn's own cells: a wait for the ID an earlier cell was
          // allocated (or `waitAfterId`, for a cell that never revealed its ID),
          // which this runtime may since have given to one of those cells.
          turn.waitedAfter = true;
          const cell = plan[turn.waitAfter - 1];
          const cellId = turn.waitAfterId ?? cell?.allocated;
          assert.ok(cell && cellId, `cell ${turn.waitAfter} has an ID to wait for`);
          turn.waiting = cell;
          item = wait(cell, cellId, false, { crossTurn: true, late: true });
        } else {
          item = { type: 'message', role: 'assistant', status: 'completed', content: [{ type: 'output_text', text: 'Isolated code-mode canary finished.', annotations: [] }] };
        }
        item.id = `fixture_${observed.requests}`;
        if (item.type !== 'message') observed.calls.push({ type: item.type, name: item.name, call_id: item.call_id });
        sse(res, item, `response_${observed.requests}`);
      } catch (error) { res.writeHead(500); res.end('Fixture rejected'); fail(error); }
    });
  });
  const open = async () => {
    const launch = commandLaunch('codex', ['app-server', '--stdio']);
    assert.ok(launch.resolved, 'Codex executable is not reachable');
    const child = spawn(launch.file, launch.args, { ...launch.options, env, cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    const state = { child, pending: new Map(), count: 0, stopping: false, lines: null };
    proc = state;
    observed.processes += 1;
    observed.stderrBytes ??= 0;
    child.stderr.on('data', (chunk) => { observed.stderrBytes += chunk.length; });
    child.once('error', fail);
    child.once('exit', (code) => { if (!state.stopping && !observed.completed) fail(new Error(`App-server exited ${code}`)); });
    const send = (value) => child.stdin.write(`${JSON.stringify(value)}\n`);
    state.send = send;
    state.rpc = (method, params) => new Promise((resolve, reject) => {
      if (failure) { reject(failure); return; }
      const id = ++state.count; state.pending.set(id, { resolve, reject }); send({ id, method, params });
    });
    state.lines = readline.createInterface({ input: child.stdout });
    state.lines.on('line', (line) => {
      try {
        const message = JSON.parse(line);
        if (message.id != null && !message.method && state.pending.has(message.id)) {
          const item = state.pending.get(message.id); state.pending.delete(message.id);
          if (message.error) item.reject(new Error(JSON.stringify(message.error))); else item.resolve(message.result);
        } else if (message.id != null && message.method) {
          // Per-call acceptance of a nested command only; never a policy amendment.
          // A refusal case's `decline` cell is declined instead (2026-10-13), and
          // `approvalDelayMs` answers late, as a person deciding would, so the
          // cell yields before its nested call is refused. The request names the
          // cell by its script, the only per-cell detail it carries.
          assert.equal(message.method, 'item/commandExecution/requestApproval', 'unexpected server request');
          observed.approvals.push(message.method);
          const named = /cell-(\d+)\.cjs/.exec(JSON.stringify(message.params ?? {}));
          const cell = named ? plan[Number(named[1]) - 1] : null;
          const decision = cell?.decline ? 'decline' : 'accept';
          observed.decisions.push({ cell: cell?.callId ?? null, decision });
          const answer = () => send({ id: message.id, result: { decision } });
          if (cell?.approvalDelayMs) setTimeout(answer, cell.approvalDelayMs); else answer();
        } else if (message.method === 'item/completed' && message.params?.item?.type === 'commandExecution') {
          observed.events.push({ status: message.params.item.status, exitCode: message.params.item.exitCode ?? null });
        } else if (message.method === 'turn/completed') {
          assert.equal(message.params.turn.status, 'completed');
          const done = active; active = null;
          if (done) done.resolve();
        } else if (message.method === 'error') throw new Error(JSON.stringify(message.params));
      } catch (error) { fail(error); }
    });
    await state.rpc('initialize', { clientInfo: { name: 'acolyte_code_mode_canary', version: '1' }, capabilities: { experimentalApi: true } });
    send({ method: 'initialized', params: {} });
  };
  const close = async () => {
    const state = proc;
    if (!state) return;
    state.stopping = true;
    const { child } = state;
    const closed = new Promise((resolve) => child.once('close', resolve));
    child.stdin.end();
    await Promise.race([closed, new Promise((resolve) => setTimeout(resolve, 1500))]);
    if (child.exitCode === null && process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    else if (child.exitCode === null) child.kill('SIGTERM');
    state.lines?.close();
    proc = null;
  };
  const threads = {};
  const threadParams = { cwd: workspace, model: 'acolyte-code-mode-fixture', modelProvider: 'fixture', approvalPolicy: 'on-request', sandbox: 'read-only' };
  try {
    await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
    fs.writeFileSync(path.join(codexHome, 'config.toml'), [
      'model="acolyte-code-mode-fixture"', 'model_provider="fixture"', 'approval_policy="on-request"', 'sandbox_mode="read-only"',
      '[features]', 'code_mode=true', 'plugins=false',
      '[model_providers.fixture]', 'name="Scripted isolated fixture"', `base_url="http://127.0.0.1:${server.address().port}/v1"`, 'wire_api="responses"', 'requires_openai_auth=false', 'request_max_retries=0', 'stream_max_retries=0', '',
    ].join('\n'));
    timer = setTimeout(() => fail(new Error('Code-mode canary timed out')), 30000 * (plan.length + turnCount - 1));
    for (const step of schedule) {
      if (failure) throw failure;
      if (!proc && (step.start || step.turn || step.resume || step.fork || step.unsubscribe)) await open();
      if (step.start) {
        const started = await proc.rpc('thread/start', threadParams);
        threads[step.start] = started.thread.id;
        observed.steps.push({ start: step.start, thread: started.thread.id });
      } else if (step.restart) {
        await close();
        await open();
        observed.steps.push({ restart: true });
      } else if (step.resume) {
        const resumed = await proc.rpc('thread/resume', { threadId: threads[step.resume], ...(step.bare ? {} : threadParams) });
        observed.steps.push({ resume: step.resume, thread: resumed.thread?.id ?? null });
        assert.equal(resumed.thread?.id, threads[step.resume], 'thread/resume returns the thread it resumed');
      } else if (step.fork) {
        const forked = await proc.rpc('thread/fork', { threadId: threads[step.fork], ...threadParams });
        threads[step.as] = forked.thread.id;
        observed.steps.push({ fork: step.fork, as: step.as, thread: forked.thread.id });
        assert.notEqual(forked.thread.id, threads[step.fork], 'a fork is a new thread');
      } else if (step.unsubscribe) {
        const result = await proc.rpc('thread/unsubscribe', { threadId: threads[step.unsubscribe] });
        observed.steps.push({ unsubscribe: step.unsubscribe, status: result?.status ?? null });
      } else if (step.turn) {
        const turn = { ...step, next: 0, requests: 0, waiting: null };
        const done = new Promise((resolve, reject) => { turn.resolve = resolve; turn.reject = reject; });
        done.catch(() => {});
        active = turn;
        // `overrides`: turn/start's own setting overrides ("for this turn and
        // subsequent turns"), to see whether a settings change alone is a boundary.
        await proc.rpc('turn/start', { threadId: threads[step.turn], input: [{ type: 'text', text: 'Run the harmless isolated code-mode cells.' }], ...(step.overrides || {}) });
        await done;
        observed.steps.push({ turn: step.turn, requests: turn.requests });
      } else if (step.exec || step.execResume) {
        // One turn as its own `codex exec` (or `codex exec resume <id>`)
        // process, as the hook harness drives it: approval never and full
        // access, because exec has no client to approve a nested command, and
        // every command here is a harmless script in the temp workspace.
        const turn = { ...step, next: 0, requests: 0, waiting: null, resolve() {}, reject() {} };
        active = turn;
        const argv = ['exec', ...(step.execResume ? ['resume'] : []), '--json', '--skip-git-repo-check',
          '-c', 'sandbox_mode="danger-full-access"', '-c', 'approval_policy="never"',
          ...(step.execResume ? [threads[step.execResume]] : []), 'Run the harmless isolated code-mode cells.'];
        const launch = commandLaunch('codex', argv);
        assert.ok(launch.resolved, 'Codex executable is not reachable');
        const child = spawn(launch.file, launch.args, { ...launch.options, env, cwd: workspace, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        observed.processes += 1;
        observed.stderrBytes ??= 0;
        child.stdin.end();
        let stdout = '';
        child.stdout.on('data', (chunk) => { stdout += chunk; });
        child.stderr.on('data', (chunk) => { observed.stderrBytes += chunk.length; });
        const killer = setTimeout(() => { if (child.exitCode === null) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 }); }, 30000 * Math.max(1, turn.plan.length + 1));
        const exit = await new Promise((resolve, reject) => { child.once('error', reject); child.once('close', resolve); });
        clearTimeout(killer);
        active = null;
        const events = stdout.split(/\r?\n/).filter(Boolean).flatMap((line) => { try { return [JSON.parse(line)]; } catch { return []; } });
        const started = events.find((event) => event.type === 'thread.started');
        observed.steps.push({ [step.exec ? 'exec' : 'execResume']: turnOf(step), exit, thread: started?.thread_id ?? null, requests: turn.requests,
          eventTypes: [...new Set(events.map((event) => event.type))] });
        if (failure) throw failure;
        assert.equal(exit, 0, `codex exec exited ${exit}`);
        if (step.exec) threads[step.exec] = started.thread_id;
        else assert.equal(started?.thread_id, threads[step.execResume], 'codex exec resume continues the thread it names');
      }
    }
    if (failure) throw failure;
    observed.completed = true;
    observed.threadId = threads.A;
  } catch (error) { observed.error = error.message; throw error; }
  finally {
    clearTimeout(timer);
    await close();
    server.closeAllConnections(); await new Promise((resolve) => server.close(resolve));
    observed.threads = threads;
    // Whether each marked command ran, read from disk after every process ended.
    for (const cell of plan) if (cell.ranMarker) record(cell.callId).ran = fs.existsSync(cell.ranMarker);
    const verdictsIn = (file) => parseCodexJsonl(fs.readFileSync(file, 'utf8'), { file });
    const cellVerdicts = (observations) => Object.fromEntries(plan.map((cell) => {
      const matches = observations.filter((item) => item.callId === cell.callId && item.command === cell.command);
      return [cell.callId, { observations: matches.length, status: matches[0]?.status ?? null, session: matches[0]?.session ?? null }];
    }));
    if (schedule.length === 2 && schedule[0].start && schedule[1].turn && threads.A) {
      // A one-turn case: one thread, one rollout, as this harness always asserted.
      observed.rolloutPath = rolloutFor(codexHome, threads.A);
      observed.rolloutHash = digest(observed.rolloutPath);
      const text = fs.readFileSync(observed.rolloutPath, 'utf8');
      const verdicts = cellVerdicts(verdictsIn(observed.rolloutPath));
      for (const cell of plan) Object.assign(record(cell.callId), { observations: verdicts[cell.callId].observations, status: verdicts[cell.callId].status });
      observed.recordTypes = text.split(/\r?\n/).filter(Boolean).map(JSON.parse)
        .map((record) => [record.type, record.payload?.type].filter(Boolean).join('/'));
    } else {
      // A continuity case: what each thread's rollout files hold, measured.
      observed.rollouts = {};
      for (const [label, id] of Object.entries(threads)) {
        const files = rolloutsFor(codexHome, id);
        observed.rollouts[label] = files.map((file) => {
          const records = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
          return { path: file, sha256: digest(file), lines: records.length,
            sessionMetas: records.flatMap((entry, line) => (entry.type !== 'session_meta' ? []
              : [{ line, id: entry.payload?.id ?? null, forkedFrom: entry.payload?.forked_from_id ?? null }])),
            turnContexts: records.filter((entry) => entry.type === 'turn_context').length,
            settingsApplied: records.filter((entry) => entry.type === 'event_msg' && entry.payload?.type === 'thread_settings_applied').length,
            yields: records.flatMap((entry, line) => {
              const payload = entry.payload || {};
              if (entry.type !== 'response_item' || !['custom_tool_call_output', 'function_call_output'].includes(payload.type)) return [];
              const header = firstLine(payload.output);
              return /^Script /.test(header) || /cell/i.test(header) ? [{ line, callId: payload.call_id, header }] : [];
            }),
            verdicts: cellVerdicts(verdictsIn(file)) };
        });
      }
      for (const cell of plan) {
        const own = observed.rollouts[cell.thread] || [];
        if (own.length === 1) Object.assign(record(cell.callId), own[0].verdicts[cell.callId]);
      }
    }
    fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  }
}

// Every spelling of one workspace path collapses onto the synthetic one.
function workspaceScrubber(workspace) {
  const forward = workspace.replace(/\\/g, '/');
  return (value) => typeof value === 'string'
    ? value.split(forward).join('C:/src/example').split(workspace).join('C:\\src\\example')
      .split(workspace.replace(/\\/g, '\\\\')).join('C:\\\\src\\\\example')
    : value;
}

// A tool output with its paths scrubbed and its run-to-run noise (chunk ids,
// wall times) fixed, so two runs write the same bytes.
function sanitizedOutput(output, scrub) {
  return Array.isArray(output)
    ? output.map((part) => ({ ...part, text: scrub(part.text).replace(/"chunk_id":"[0-9a-f]+"/, '"chunk_id":"c0ffee"')
      .replace(/Wall time [0-9.]+ seconds/, 'Wall time 1.0 seconds').replace(/"wall_time_seconds":[0-9.]+/, '"wall_time_seconds":1.0') }))
    : scrub(output).replace(/Wall time [0-9.]+ seconds/, 'Wall time 1.0 seconds')
      // A direct exec_command's own header spells both differently (the refusal
      // cases, 2026-10-13). Neither form occurs in the older fixtures' outputs.
      .replace(/^Chunk ID: [0-9a-f]+$/m, 'Chunk ID: c0ffee').replace(/^Wall time: [0-9.]+ seconds$/m, 'Wall time: 1.0 seconds');
}

const TOOL_RECORDS = ['custom_tool_call', 'custom_tool_call_output', 'function_call', 'function_call_output'];

// Synthetic values in the real structure. Only the record kinds the parser
// reads (and the session head it seeds from) survive; every path collapses onto
// one synthetic workspace, and ids/timestamps are renumbered in order.
function sanitizedFixture(rolloutPath, workspace) {
  const records = fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const scrub = workspaceScrubber(workspace);
  const lines = [];
  let ordinal = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 13, 12, 0, ordinal)).toISOString();
  const session = '0192cccc-3333-7000-8000-00000000cc01';
  const turn = '0192cccc-3333-7000-8000-00000000cc02';
  const push = (type, payload) => { lines.push(JSON.stringify({ timestamp: stamp(), ordinal, type, payload })); ordinal += 1; };
  const meta = records.find((record) => record.type === 'session_meta')?.payload || {};
  // Field values that describe the Codex build and this harness (version,
  // originator = the harness's own clientInfo name, source, history mode) are
  // kept because they are what the fixture is evidence OF; everything that
  // describes the machine is replaced.
  const kept = (value) => (typeof value === 'string' ? value : 'unknown');
  push('session_meta', { session_id: session, id: session, timestamp: stamp(), cwd: 'C:\\src\\example',
    originator: kept(meta.originator), cli_version: kept(meta.cli_version), source: kept(meta.source),
    model_provider: 'example', base_instructions: 'Synthetic fixture. No real instructions are reproduced here.',
    history_mode: kept(meta.history_mode) });
  push('turn_context', { turn_id: turn, cwd: 'C:\\src\\example', approval_policy: 'on-request', sandbox_policy: 'read-only', model: 'example-model' });
  let n = 0;
  for (const record of records) {
    const payload = record.payload;
    if (record.type !== 'response_item' || !TOOL_RECORDS.includes(payload?.type)) continue;
    n += 1;
    const copy = { type: payload.type, id: `${payload.type === 'function_call' || payload.type === 'custom_tool_call' ? 'fc' : 'out'}_cc${String(n).padStart(6, '0')}`,
      call_id: payload.call_id };
    if (payload.name !== undefined) copy.name = payload.name;
    if (payload.input !== undefined) copy.input = scrub(payload.input);
    if (payload.arguments !== undefined) copy.arguments = scrub(payload.arguments);
    if (payload.output !== undefined) copy.output = sanitizedOutput(payload.output, scrub);
    copy.internal_chat_message_metadata_passthrough = { turn_id: turn };
    push('response_item', copy);
  }
  push('event_msg', { type: 'task_complete', turn_id: turn });
  return lines.join('\n') + '\n';
}

// Every continuity rollout, one segment per thread file in case order, for
// test/codex-code-mode-continuity.test.js (2026-10-13). The rule above, plus what
// the continuity tests read: every turn_context (one per turn) with each
// record's own turn, every event_msg/thread_settings_applied (type and thread
// only: its settings name the cwd) and every task_complete. Each segment gets
// its own synthetic session id; a fork keeps `forked_from_id`, renamed to its
// parent segment's id; `fixture_case` names the case and thread it came from.
// `ids` keeps another fixture's synthetic ids apart (the refusal fixture's).
function sanitizedContinuityFixture(segments, ids = { session: '0192eeee-5555', item: 'ee' }) {
  const lines = [];
  const sessions = new Map();
  let clock = 0;
  const stamp = () => new Date(Date.UTC(2026, 9, 13, 14, 0, 0, 10 * clock++)).toISOString();
  const kept = (value) => (typeof value === 'string' ? value : 'unknown');
  segments.forEach(({ name, label, rolloutPath, workspace }, index) => {
    const records = fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
    const scrub = workspaceScrubber(workspace);
    const n = String(index + 1).padStart(2, '0');
    const meta = records.find((record) => record.type === 'session_meta')?.payload || {};
    const session = `${ids.session}-7000-8000-0000000000${n}`;
    sessions.set(meta.id, session);
    const turns = new Map();
    const turnId = (real) => {
      if (!turns.has(real)) turns.set(real, `${ids.session}-7000-9000-00${n}000000${String(turns.size + 1).padStart(2, '0')}`);
      return turns.get(real);
    };
    let ordinal = 0, number = 0;
    const push = (type, payload) => { lines.push(JSON.stringify({ timestamp: stamp(), ordinal: ordinal++, type, payload })); };
    push('session_meta', { session_id: session, id: session,
      ...(meta.forked_from_id ? { forked_from_id: sessions.get(meta.forked_from_id) ?? 'unknown-parent' } : {}),
      cwd: 'C:\\src\\example', originator: kept(meta.originator), cli_version: kept(meta.cli_version), source: kept(meta.source),
      model_provider: 'example', base_instructions: 'Synthetic fixture. No real instructions are reproduced here.',
      history_mode: kept(meta.history_mode), fixture_case: `${name}/${label}` });
    for (const record of records) {
      const payload = record.payload || {};
      if (record.type === 'turn_context') {
        push('turn_context', { turn_id: turnId(payload.turn_id), cwd: 'C:\\src\\example', approval_policy: kept(payload.approval_policy),
          sandbox_policy: kept(payload.sandbox_policy?.type), model: payload.model === 'acolyte-code-mode-fixture' ? 'example-model' : 'example-model-override' });
      } else if (record.type === 'event_msg' && payload.type === 'thread_settings_applied') {
        push('event_msg', { type: 'thread_settings_applied', thread_id: sessions.get(payload.thread_id) ?? 'unknown-thread' });
      } else if (record.type === 'event_msg' && payload.type === 'task_complete') {
        push('event_msg', { type: 'task_complete', turn_id: turnId(payload.turn_id) });
      } else if (record.type === 'response_item' && TOOL_RECORDS.includes(payload.type)) {
        number += 1;
        const copy = { type: payload.type, id: `${payload.type.endsWith('_output') ? 'out' : 'fc'}_${ids.item}${n}${String(number).padStart(4, '0')}`,
          call_id: payload.call_id };
        if (payload.name !== undefined) copy.name = payload.name;
        if (payload.input !== undefined) copy.input = scrub(payload.input);
        if (payload.arguments !== undefined) copy.arguments = scrub(payload.arguments);
        if (payload.output !== undefined) copy.output = sanitizedOutput(payload.output, scrub);
        copy.internal_chat_message_metadata_passthrough = { turn_id: turnId(payload.internal_chat_message_metadata_passthrough?.turn_id) };
        push('response_item', copy);
      }
    }
  });
  return lines.join('\n') + '\n';
}

// What a wait for an EARLIER cell returned, in the runtime's own words.
const waitOutcome = (wait) => (wait.resultHeader === 'Script completed' ? 'completed'
  : /^Script failed\n[\s\S]*\nScript error:\nexec cell [A-Za-z0-9_-]+ not found$/.test(wait.resultText || '') ? 'not-found'
    : `other (${wait.resultHeader ?? 'no result'})`);

// The measured facts each continuity case states (CONTINUITY_CASES), and the
// parser's exact verdict on every cell.
function assertContinuity(name, observed, expect) {
  assert.equal(observed.approvals.length, observed.cells.filter((cell) => cell.via === 'app-server').length,
    `${name}: one individually accepted nested command per app-server cell`);
  assert.deepEqual(observed.cells.map((cell) => cell.allocated ?? null), expect.allocated, `${name}: WITNESS the cell ID each cell was allocated`);
  assert.deepEqual(observed.waits.filter((wait) => wait.crossTurn).map(waitOutcome), expect.waits || [],
    `${name}: WITNESS what each wait for an earlier cell returned`);
  for (const [label, files] of Object.entries(observed.rollouts || {})) {
    assert.equal(files.length, 1, `${name}/${label}: WITNESS one rollout file per thread, however many processes wrote it`);
    const [rollout] = files;
    assert.equal(rollout.sessionMetas.length, 1, `${name}/${label}: WITNESS one session_meta in it`);
    const parent = expect.forkedFrom?.[label];
    assert.equal(rollout.sessionMetas[0].forkedFrom, parent ? observed.threads[parent] : null, `${name}/${label}: WITNESS the parent a fork names`);
    assert.equal(rollout.settingsApplied, expect.reloads?.[label] ?? 0, `${name}/${label}: WITNESS thread_settings_applied records`);
    for (const cell of observed.cells) assert.equal(rollout.verdicts[cell.callId].observations, cell.thread === label ? 1 : 0,
      `${name}/${cell.callId}: WITNESS observed in its own thread's rollout (${cell.thread}) and no other (${label})`);
  }
  for (const cell of observed.cells) {
    assert.equal(cell.observations, 1, `${name}/${cell.callId}: WITNESS exactly one observation`);
    assert.equal(cell.status, cell.expected, `${name}/${cell.callId}: the parser's verdict`);
  }
}

// The measured facts each refusal case states (REFUSAL_CASES): who was asked,
// what was refused and in which words, that a refused command never ran and
// every other one did, and the parser's exact verdict on every call. Each
// call's TERMINAL output is read from the rollout -- the cell's own, the last
// wait's for a continued cell, or a direct call's -- and recorded.
function assertRefusal(name, observed) {
  const rolloutPath = observed.rolloutPath ?? observed.rollouts?.A?.[0]?.path;
  assert.ok(rolloutPath, `${name}: WITNESS one rollout`);
  if (observed.rollouts) assert.equal(observed.rollouts.A.length, 1, `${name}: WITNESS one rollout file`);
  const outputs = fs.readFileSync(rolloutPath, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse)
    .filter((entry) => entry.type === 'response_item' && ['custom_tool_call_output', 'function_call_output'].includes(entry.payload?.type))
    .map((entry) => entry.payload);
  const prompted = observed.cells.filter((cell) => cell.via === 'app-server');
  assert.deepEqual(observed.decisions, prompted.map((cell) => ({ cell: cell.callId, decision: cell.decline ? 'decline' : 'accept' })),
    `${name}: WITNESS one approval request per app-server call, each answered as the case says, and none under codex exec`);
  for (const cell of observed.cells) {
    const waits = observed.waits.filter((wait) => wait.cell === cell.callId);
    assert.equal(waits.length > 0, cell.continued, `${name}/${cell.callId}: WITNESS ${cell.continued ? 'the cell yielded and a wait finished it' : 'no wait'}`);
    const terminalId = waits.length ? waits.at(-1).callId : cell.callId;
    const terminal = outputs.filter((output) => output.call_id === terminalId);
    assert.equal(terminal.length, 1, `${name}/${cell.callId}: WITNESS one terminal output`);
    cell.terminal = { type: terminal[0].type, output: terminal[0].output };
    assert.equal(cell.ran, !cell.refused, `${name}/${cell.callId}: WITNESS the command ${cell.refused ? 'never ran' : 'ran'}`);
    if (cell.refused && cell.direct) {
      assert.equal(cell.terminal.output, REFUSALS[cell.refused], `${name}/${cell.callId}: WITNESS the ${cell.refused} refusal, as a direct call`);
    } else if (cell.refused) {
      const parts = Array.isArray(cell.terminal.output) ? cell.terminal.output.map((part) => part?.text) : [cell.terminal.output];
      assert.equal(parts.length, 2, `${name}/${cell.callId}: WITNESS a two-part result`);
      assert.match(parts[0], /^Script failed\nWall time [0-9.]+ seconds\nOutput:\n$/, `${name}/${cell.callId}: WITNESS a "Script failed" head, nothing under Output:`);
      assert.equal(parts[1], `Script error:\n${REFUSALS[cell.refused]}`, `${name}/${cell.callId}: WITNESS the ${cell.refused} refusal, in a cell`);
    }
    assert.equal(cell.observations, 1, `${name}/${cell.callId}: WITNESS exactly one observation`);
    assert.equal(cell.status, cell.expected, `${name}/${cell.callId}: the parser's verdict`);
  }
}

(async () => {
  evidence.subject = subject;
  evidence.parserHash = digest(path.join(subject, 'src/history-adapters.js'));
  evidence.harnessHash = digest(__filename);
  const version = commandLaunch('codex', ['--version']);
  evidence.codexVersion = String(spawnSync(version.file, version.args, { ...version.options, encoding: 'utf8', windowsHide: true, timeout: 10000 }).stdout || '').trim();
  const failures = [];
  const known = [...CASES, ...CONTINUITY_CASES, ...REFUSAL_CASES].map(([name]) => name);
  for (const name of selectedCases) assert.ok(known.includes(name), `--case ${name}: no such case (${known.join(', ')})`);
  const chosen = (list) => list.filter(([name]) => !selectedCases.length || selectedCases.includes(name));
  for (const [name, steps, expect] of chosen(CONTINUITY_CASES)) {
    try { await run(name, steps); }
    catch (error) { failures.push(`${name}: ${error.message}`); continue; }
    const observed = evidence.cases[evidence.cases.length - 1];
    observed.expect = expect;
    try { assertContinuity(name, observed, expect); observed.passed = true; }
    catch (error) { failures.push(error.message); }
  }
  for (const [name, steps] of chosen(CASES)) {
    try { await run(name, steps); }
    catch (error) { failures.push(`${name}: ${error.message}`); continue; }
    const observed = evidence.cases[evidence.cases.length - 1];
    try {
      assert.equal(observed.approvals.length, observed.cells.length, `${name}: one individually accepted nested command per cell`);
      for (const cell of observed.cells) {
        const waits = observed.waits.filter((wait) => wait.cell === cell.callId);
        assert.equal(waits.length > 0, cell.continued, `${name}/${cell.callId}: WITNESS a continued cell, and only one, yielded and was resumed by wait`);
        if (cell.rewaited) assert.ok(waits.some((wait) => wait.afterType === 'function_call_output'),
          `${name}/${cell.callId}: WITNESS a wait itself yielded again`);
        assert.equal(waits.filter((wait) => wait.terminate).length, cell.terminate ? 1 : 0,
          `${name}/${cell.callId}: WITNESS a terminated cell, and only one, was stopped by wait`);
        assert.equal(cell.observations, 1, `${name}/${cell.callId}: WITNESS exactly one observation per cell`);
        // Exact since 2026-10-13: the parser joins a wait's result back to the
        // cell it names, so a continued cell carries its true outcome, and a
        // terminated one has none. Against a parser without the join, every
        // continued cell reads `unknown` and this fails.
        assert.equal(cell.status, cell.expected, `${name}/${cell.callId}: ${!cell.continued ? 'a completed cell carries its own outcome'
          : cell.terminate ? 'a terminated cell is never credited' : 'a continued cell carries the outcome its wait reported'}`);
      }
      observed.passed = true;
    } catch (error) { failures.push(error.message); }
  }
  for (const [name, steps] of chosen(REFUSAL_CASES)) {
    try { await run(name, steps); }
    catch (error) { failures.push(`${name}: ${error.message}`); continue; }
    const observed = evidence.cases[evidence.cases.length - 1];
    try { assertRefusal(name, observed); observed.passed = true; }
    catch (error) { failures.push(error.message); }
  }
  const sequence = evidence.cases.find((item) => item.name === 'sequence');
  if (option('--write-fixture') && sequence?.rolloutPath) {
    const target = path.resolve(option('--write-fixture'));
    fs.writeFileSync(target, sanitizedFixture(sequence.rolloutPath, path.join(root, 'sequence', 'workspace')));
    evidence.fixture = { path: target, sha256: digest(target) };
  }
  // A multi-case fixture: every case of its list must have run, one segment per
  // thread rollout in case order.
  const writeSegments = (flag, list, ids, key) => {
    if (!option(flag)) return;
    const ran = list.map(([name]) => evidence.cases.find((item) => item.name === name && item.completed));
    const missing = list.filter((_, index) => !ran[index]).map(([name]) => name);
    if (missing.length) failures.push(`${flag} needs every case of its list to have run; missing: ${missing.join(', ')}`);
    else {
      const segments = ran.flatMap((observed) => {
        const workspace = path.join(root, observed.name, 'workspace');
        return observed.rollouts
          ? Object.entries(observed.rollouts).map(([label, files]) => ({ name: observed.name, label, rolloutPath: files[0].path, workspace }))
          : [{ name: observed.name, label: 'A', rolloutPath: observed.rolloutPath, workspace }];
      });
      const target = path.resolve(option(flag));
      fs.writeFileSync(target, sanitizedContinuityFixture(segments, ids));
      evidence[key] = { path: target, sha256: digest(target), segments: segments.length };
    }
  };
  writeSegments('--write-continuity-fixture', CONTINUITY_CASES, undefined, 'continuityFixture');
  writeSegments('--write-refusal-fixture', REFUSAL_CASES, { session: '0192ffff-6666', item: 'ff' }, 'refusalFixture');
  evidence.status = failures.length ? 'failed' : 'passed';
  evidence.failures = failures;
  fs.writeFileSync(path.join(root, 'evidence.json'), JSON.stringify(evidence, null, 2));
  console.log(JSON.stringify({ status: evidence.status, evidence: path.join(root, 'evidence.json'), codexVersion: evidence.codexVersion,
    cases: evidence.cases.map(({ name, approvals, waits, cells }) => ({ name, approvals: approvals.length, waits: waits.length,
      cells: cells.map(({ callId, continued, rewaited, terminate, leaveOpen, expected, status, allocated, thread, direct, refused }) =>
        `${callId}:${direct ? 'direct' : !continued ? 'complete' : terminate ? 'terminated' : rewaited ? 'rewaited' : leaveOpen ? 'left-open' : 'continued'}`
        + `${refused ? ` refused (${refused})` : ''}:${expected}->${status}`
        + (allocated !== undefined ? ` (thread ${thread}, cell ID ${allocated})` : '')),
      ...(waits.some((wait) => wait.crossTurn) ? { crossTurnWaits: waits.filter((wait) => wait.crossTurn)
        .map((wait) => `${wait.cell} as cell ID ${wait.cellId}: ${wait.resultHeader ?? '(no result)'}`) } : {}) })),
    failures }, null, 1));
  if (failures.length) process.exitCode = 1;
})().catch((error) => { console.error(JSON.stringify({ evidence: path.join(root, 'evidence.json'), error: error.message })); process.exitCode = 1; });
