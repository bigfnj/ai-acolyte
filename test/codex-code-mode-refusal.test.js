'use strict';

// A NESTED COMMAND CODEX REFUSED BEFORE IT RAN, BESIDE ONE THAT RAN AND FAILED.
//
// The fixture is the sanitized rollouts of the code-mode harness's refusal cases
// (scripts/check-codex-code-mode-runtime.js, REFUSAL_CASES; codex-cli 0.161.0,
// Windows, code_mode enabled only in temp homes, scripted loopback provider), one
// segment per rollout, each with its own session id and a `fixture_case`.
// Regenerate with:
//   node scripts/check-codex-code-mode-runtime.js --extension-dir . \
//     --write-refusal-fixture test/fixtures/codex-code-mode-refusal-sanitized.jsonl
//
// Every session runs, in order: a cell whose nested exec_command is refused, a
// cell whose command runs and exits nonzero, and the same two as DIRECT
// exec_command calls (declined-after-yield: the two cells only). The harness
// proved with a marker file that each refused command never ran and each other
// one did. Measured 2026-10-13, and what each test below leans on:
//   - refused-never: `codex exec`, approval never, an escalation request. No
//     prompt; the refusal is "approval policy is Never; reject command — you
//     cannot ask for escalated permissions if the approval policy is Never";
//   - declined: an app-server prompt answered `decline`. The refusal is
//     exec_command failed: CreateProcess { message: "Rejected(\"rejected by user\")" };
//   - declined-after-yield: the decline answered 3 s late, so the cell yields
//     first and the refusal arrives as its WAIT's result;
//   - a direct call's whole output is the refusal message; a cell's result is a
//     "Script failed" head with nothing under Output: beside "Script error:\n"
//     plus the same message.
// The parser read the cell's "Script failed" as the command's failure, while the
// same refusal as a direct call already read `unknown`. A refusal is not a
// failure: a requested call that never ran is no evidence. The cell now reads as
// the direct call does (src/history-adapters.js, codeModeRefused).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCodexJsonl, scanHistoryFiles } = require('../src/history-adapters');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-code-mode-refusal-sanitized.jsonl');
const TEXT = fs.readFileSync(FIXTURE, 'utf8');
const RECORDS = TEXT.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const FILE = 'C:\\src\\example\\rollout.jsonl';

const REFUSED = {
  never: 'approval policy is Never; reject command \u2014 you cannot ask for escalated permissions if the approval policy is Never',
  declined: 'exec_command failed: CreateProcess { message: "Rejected(\\"rejected by user\\")" }',
};

const SEGMENTS = (() => {
  const out = new Map();
  let current = null;
  for (const record of RECORDS) {
    if (record.type === 'session_meta') { current = []; out.set(record.payload.fixture_case, current); }
    current.push(record);
  }
  return out;
})();
const segment = (key) => { assert.ok(SEGMENTS.has(key), `the fixture holds ${key}`); return SEGMENTS.get(key); };

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';
const parse = (records) => parseCodexJsonl(jsonl(records), { file: FILE, platform: 'win32' });
const statuses = (records) => Object.fromEntries(parse(records).map((item) => [item.callId, item.status]));
const edited = (record, change) => ({ ...record, payload: change({ ...record.payload }) });
const find = (records, type, callId) => records.find((record) => record.payload?.type === type && record.payload?.call_id === callId);
const waitsFor = (records, cellId) => records.filter((record) => record.payload?.type === 'function_call'
  && record.payload.name === 'wait' && JSON.parse(record.payload.arguments).cell_id === cellId);
// The record that decided a call: a direct call's output, a cell's own result,
// or, for a cell that yielded, its last wait's result.
function terminal(records, callId) {
  const own = find(records, 'custom_tool_call_output', callId) ?? find(records, 'function_call_output', callId);
  const header = Array.isArray(own.payload.output) ? own.payload.output[0].text : own.payload.output;
  const yielded = /^Script running with cell ID (\S+)\n/.exec(header);
  return yielded ? find(records, 'function_call_output', waitsFor(records, yielded[1]).at(-1).payload.call_id) : own;
}
const replaced = (records, target, change) => records.map((record) => (record !== target ? record : edited(record, change)));
const withError = (records, callId, text) => replaced(records, terminal(records, callId),
  (payload) => ({ ...payload, output: [payload.output[0], { ...payload.output[1], text }] }));

// What each call truly did: `null` for a command that never ran (no outcome to be
// true to, so withholding is the only right answer), else its real outcome.
const TRUTH = {
  'refused-never/A': { call_cell_1: null, call_cell_2: 'failed', call_cell_3: null, call_cell_4: 'failed' },
  'declined/A': { call_cell_1: null, call_cell_2: 'failed', call_cell_3: null, call_cell_4: 'failed' },
  'declined-after-yield/A': { call_cell_1: null, call_cell_2: 'failed' },
};
const VERDICTS = Object.fromEntries(Object.entries(TRUTH).map(([key, calls]) =>
  [key, Object.fromEntries(Object.entries(calls).map(([callId, truth]) => [callId, truth ?? 'unknown']))]));
const REFUSAL_OF = { 'refused-never/A': 'never', 'declined/A': 'declined', 'declined-after-yield/A': 'declined' };

test('the fixture really holds the measured refusals, each beside a command that ran and failed', () => {
  assert.deepEqual([...SEGMENTS.keys()], Object.keys(TRUTH), 'every refusal case, in case order');
  for (const [key, records] of SEGMENTS) {
    assert.equal(records[0].payload.cli_version, '0.161.0', `${key} names the build it came from`);
    const policy = records.find((record) => record.type === 'turn_context').payload.approval_policy;
    assert.equal(policy, key === 'refused-never/A' ? 'never' : 'on-request', `${key}: WITNESS the approval policy it ran under`);
    const message = REFUSED[REFUSAL_OF[key]];
    // The refused cell: the runtime's two-part script error, the message inside it.
    assert.deepEqual(terminal(records, 'call_cell_1').payload.output.map((part) => part.text),
      ['Script failed\nWall time 1.0 seconds\nOutput:\n', `Script error:\n${message}`], `${key}: WITNESS the refused cell's exact result`);
    assert.match(find(records, 'custom_tool_call', 'call_cell_1').payload.input, /tools\.exec_command\(\{ cmd: .*, sandbox_permissions: "require_escalated", /,
      `${key}: the refused cell asked for escalation`);
    // The cell that ran: a completion carrying the command's own nonzero exit.
    const ran = terminal(records, 'call_cell_2').payload.output.map((part) => part.text);
    assert.match(ran[0], /^Script completed\n/, `${key}: WITNESS the other cell's script completed`);
    assert.match(ran[1], /"exit_code":1,/, `${key}: and its command exited nonzero`);
  }
  for (const key of ['refused-never/A', 'declined/A']) {
    const records = segment(key);
    // The same refusal as a direct call: the whole output is the message, so the
    // cell's error part is the direct call's output, word for word.
    assert.equal(terminal(records, 'call_cell_3').payload.output, REFUSED[REFUSAL_OF[key]], `${key}: WITNESS the refused direct call's output`);
    assert.match(terminal(records, 'call_cell_4').payload.output, /\nProcess exited with code 1\n/, `${key}: WITNESS the direct call that ran exited nonzero`);
  }
  // The late decline: the cell yielded first, and the refusal came back to its wait.
  const late = segment('declined-after-yield/A');
  assert.match(find(late, 'custom_tool_call_output', 'call_cell_1').payload.output, /^Script running with cell ID 1\n/, 'WITNESS the cell yielded before the decline');
  assert.equal(terminal(late, 'call_cell_1').payload.type, 'function_call_output', 'WITNESS the refusal arrived as the wait\'s result');
});

test('a cell whose nested command was refused is withheld, exactly as the same refusal as a direct call is', () => {
  for (const [key, expected] of Object.entries(VERDICTS)) assert.deepEqual(statuses(segment(key)), expected, key);
  for (const key of ['refused-never/A', 'declined/A']) {
    const read = statuses(segment(key));
    assert.equal(read.call_cell_1, read.call_cell_3, `${key}: the refused cell reads as the refused direct call does`);
    assert.equal(read.call_cell_2, read.call_cell_4, `${key}: and the cell that ran as the direct call that ran`);
  }
  // The whole fixture at once: every segment reuses call_cell_1.., under its own
  // session, which call groups and cell IDs are both scoped by.
  const sessionOf = new Map([...SEGMENTS].map(([key, records]) => [records[0].payload.id, key]));
  const whole = {};
  for (const item of parse(RECORDS)) (whole[sessionOf.get(item.session)] ??= {})[item.callId] = item.status;
  assert.deepEqual(whole, VERDICTS);
});

// THE PROPERTY, on these real records: every call gets its true outcome or is
// withheld, never the opposite; a command that never ran has no outcome, so
// withheld is the only answer -- read as `failed` before this change.
test('a refused command is never counted as a failure, and a command that ran is never credited with the opposite', () => {
  for (const [key, calls] of Object.entries(TRUTH)) {
    const read = statuses(segment(key));
    for (const [callId, truth] of Object.entries(calls)) {
      if (truth === null) assert.equal(read[callId], 'unknown', `${key}/${callId} never ran and read as ${read[callId]}`);
      else assert.ok([truth, 'unknown'].includes(read[callId]), `${key}/${callId} actually ${truth} and read as ${read[callId]}`);
    }
  }
});

// The refusal is recognised or not, and a cell result shows which: recognised, the
// cell is withheld; not, the "Script failed" head counts it failed, as any script
// failure does. Only the exact shape and the exact measured message count.
test('only the exact measured refusal, in the runtime\'s two-part shape, withholds a cell', () => {
  const variants = [
    ['a thrown Error\'s spelling', (output, message) => [output[0], { ...output[1], text: `Script error:\nError: ${message}\n    at exec_main.mjs:2:7` }]],
    ['the message with trailing text', (output) => [output[0], { ...output[1], text: `${output[1].text} (retry)` }]],
    ['the message with leading text', (output, message) => [output[0], { ...output[1], text: `Script error:\nnested: ${message}` }]],
    ['a third part beside it', (output) => [...output, { type: 'input_text', text: 'stray' }]],
    ['stdout below Output:', (output) => [{ ...output[0], text: `${output[0].text}stray stdout\n` }, output[1]]],
    ['one string, not two parts', (output) => output.map((part) => part.text).join('')],
    ['the error part without its prefix', (output, message) => [output[0], { ...output[1], text: message }]],
    ['another approval policy named', (output, message) => [output[0], { ...output[1], text: `Script error:\n${message.replace(/Never/g, 'OnRequest')}` }]],
    ['a rejection that is not CreateProcess\'s', (output, message) => [output[0], { ...output[1], text: `Script error:\n${message.replace('CreateProcess', 'SpawnProcess')}` }]],
  ];
  for (const key of ['refused-never/A', 'declined/A', 'declined-after-yield/A']) {
    const records = segment(key);
    const message = REFUSED[REFUSAL_OF[key]];
    assert.equal(statuses(records).call_cell_1, 'unknown', `${key}: control, the real refusal withholds`);
    for (const [label, change] of variants) {
      // Each rewording applies to the message that contains its words.
      if (label === 'another approval policy named' && REFUSAL_OF[key] !== 'never') continue;
      if (label === 'a rejection that is not CreateProcess\'s' && REFUSAL_OF[key] !== 'declined') continue;
      const forged = replaced(records, terminal(records, 'call_cell_1'), (payload) => ({ ...payload, output: change(payload.output, message) }));
      assert.equal(statuses(forged).call_cell_1, 'failed', `${key}, ${label}: not the measured refusal, so the script's failure counts`);
    }
    // Either measured refusal is recognised in either session: the set is the measured messages, not one per path.
    const other = REFUSED[REFUSAL_OF[key] === 'never' ? 'declined' : 'never'];
    assert.equal(statuses(withError(records, 'call_cell_1', `Script error:\n${other}`)).call_cell_1, 'unknown', `${key}: the other measured refusal`);
  }
  // ANY REJECTION REASON (2026-10-20). Codex 0.162.0-alpha.17.2's guardian reviewer rejects an
  // escalation with its own reason in the declined message's place; measured 19 in one day on the
  // live-hook box, each the exact two-part shape. Withheld like the user's decline, never failed.
  // MUTATION: drop CODE_MODE_REJECTED_RE from codeModeRefused and both read `failed`.
  const declinedRecords = segment('declined/A');
  for (const reason of ['rejected by guardian',
    'This action was rejected due to unacceptable risk.\\\\nReason: the destination is outside the workspace.']) {
    const guardian = replaced(declinedRecords, terminal(declinedRecords, 'call_cell_1'), (payload) => ({ ...payload,
      output: [payload.output[0], { ...payload.output[1], text: `Script error:\n${REFUSED.declined.replace('rejected by user', reason)}` }] }));
    assert.equal(statuses(guardian).call_cell_1, 'unknown', `a rejection whose reason is "${reason}" is a refusal`);
  }
  // The change is scoped to code-mode results; the direct shape it mirrors is
  // untouched. A direct call's output is the bare message (measured, above, and
  // it reads unknown), never this two-part shape, and one forged into it keeps
  // the reading it had before this change.
  const declined = segment('declined/A');
  const direct = terminal(declined, 'call_cell_3');
  const cellShape = terminal(declined, 'call_cell_1').payload.output;
  assert.equal(statuses(replaced(declined, direct, (payload) => ({ ...payload, output: cellShape }))).call_cell_3, 'failed',
    'a direct call\'s output in the cell shape is read as it was before this change');
});

test('a refusal that reaches a yielded cell through its wait closes the cell with nothing', () => {
  const records = segment('declined-after-yield/A');
  assert.equal(statuses(records).call_cell_1, 'unknown', 'the refused cell is withheld');
  assert.deepEqual(parse(records)._codexUnmatchedWaits, [], 'and asks for no widen: its cell is in the file');
  // Control: the same wait result as an ordinary script failure is the cell's failure.
  assert.equal(statuses(withError(records, 'call_cell_1', 'Script error:\nError: boom\n    at exec_main.mjs:2:7')).call_cell_1, 'failed',
    'control: a thrown Error through the wait still fails the cell');
  // The refusal is terminal: a later wait for the same cell, carrying a real
  // completion, cannot credit it. (Cell 2's real completion, re-addressed to 1.)
  const completion = terminal(records, 'call_cell_2');
  const late = [...records.slice(0, -1),
    edited(waitsFor(records, '2')[0], (payload) => ({ ...payload, call_id: 'call_wait_late', arguments: JSON.stringify({ cell_id: '1', yield_time_ms: 10000 }) })),
    edited(completion, (payload) => ({ ...payload, call_id: 'call_wait_late' })), records.at(-1)];
  assert.equal(statuses(late).call_cell_1, 'unknown', 'a cell closed by its refusal stays closed');
  // And a cell that yielded and whose later wait reports a REAL nonzero exit stays failed.
  assert.equal(statuses(records).call_cell_2, 'failed');
});

// THE APPEND-SLICE IDENTITY RULE (9abc330): cut between the refused cell's yield
// and its wait, and between the wait and its result, through the overlap and
// through the bounded widen; the latest verdict per id equals a full read's.
test('append slices across a refused cell\'s wait reach the full-read ids and verdicts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-code-mode-refusal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let directory = 0;
  const scan = (records, cut, overlapBytes) => {
    const file = path.join(root, `case-${directory += 1}`, 'rollout.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl(records.slice(0, cut)));
    const first = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], overlapBytes });
    fs.appendFileSync(file, jsonl(records.slice(cut)));
    const second = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], cursors: first.cursors, overlapBytes });
    return { first, second };
  };
  const records = segment('declined-after-yield/A');
  const { first } = scan(records, records.length, 1);
  const full = new Map(first.observations.map((item) => [item.id, [item.callId, item.status]]));
  assert.deepEqual(Object.fromEntries([...full.values()]), VERDICTS['declined-after-yield/A'], 'precondition, the full read');
  const yieldAt = records.indexOf(find(records, 'custom_tool_call_output', 'call_cell_1')) + 1;
  const waitAt = records.indexOf(waitsFor(records, '1')[0]) + 1;
  for (const cut of [yieldAt, waitAt]) {
    for (const overlapBytes of [256 * 1024, 1]) {
      const { first: before, second } = scan(records, cut, overlapBytes);
      assert.equal(second.files[0].mode, 'append', `cut ${cut} overlap ${overlapBytes}: precondition, an append slice`);
      assert.equal(second.files[0].unmatchedResults, undefined, `cut ${cut} overlap ${overlapBytes}: nothing left unmatched`);
      const latest = new Map();
      for (const item of [...before.observations, ...second.observations]) latest.set(item.id, [item.callId, item.status]);
      assert.deepEqual(latest, full, `cut ${cut} overlap ${overlapBytes}: the full-read ids and verdicts`);
    }
  }
});

// THE SANITIZATION GATE, as for the other real-rollout fixtures.
test('the refusal fixture leaks nothing about the machine that produced it', () => {
  const lower = TEXT.toLowerCase();
  const username = (os.userInfo().username || '').toLowerCase();
  const hostname = (os.hostname() || '').toLowerCase();
  if (username.length >= 3) assert.equal(lower.includes(username), false, 'the fixture names the current user');
  if (hostname.length >= 3) assert.equal(lower.includes(hostname), false, 'the fixture names this machine');
  for (const marker of ['users\\\\', 'users/', '/home/', 'appdata', 'temp\\\\', '/tmp/', 'onedrive', '~1', 'agents.md', 'win_devtools',
    'instructions>', '.ran']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  assert.equal(lower.replace(/acolyte-code-mode-witness/g, '').includes('acolyte-code-mode-'), false, 'the fixture names a harness temp tree');
  for (const marker of ['accent' + 'ure', '.ai-work', 'ai-platform', 'grimoire']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  const kinds = new Set(RECORDS.map((record) => [record.type, record.payload?.type].filter(Boolean).join('/')));
  assert.deepEqual([...kinds].sort(), ['event_msg/task_complete', 'response_item/custom_tool_call', 'response_item/custom_tool_call_output',
    'response_item/function_call', 'response_item/function_call_output', 'session_meta', 'turn_context'], 'only the record kinds the tests read survive');
  const strings = [];
  const walk = (value) => {
    if (typeof value === 'string') { strings.push(value); try { walk(JSON.parse(value)); } catch { /* not nested JSON */ } }
    else if (Array.isArray(value)) value.forEach(walk);
    else if (value && typeof value === 'object') Object.values(value).forEach(walk);
  };
  RECORDS.forEach(walk);
  let paths = 0;
  for (const value of strings) {
    for (const match of value.matchAll(/[A-Za-z]:[\\/][^"\s,}]*/g)) {
      assert.match(match[0].replace(/\\\\/g, '\\'), /^C:[\\/]src([\\/]|$)/, `unexpected absolute path ${match[0]}`);
      paths += 1;
    }
  }
  assert.ok(paths >= 10, `WITNESS the path scan found ${paths} absolute paths to check`);
});
