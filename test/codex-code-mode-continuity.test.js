'use strict';

// CODE-MODE CELLS ACROSS TURNS, RESUMES AND FORKS, AS CODEX 0.161.0 WRITES THEM.
//
// The fixture is the sanitized rollouts of the code-mode harness's continuity cases
// (scripts/check-codex-code-mode-runtime.js, CONTINUITY_CASES; codex-cli 0.161.0,
// Windows, code_mode enabled only in temp homes, scripted loopback provider), one
// segment per thread rollout, each with its own session id and a `fixture_case`
// naming the case and thread. Regenerate with:
//   node scripts/check-codex-code-mode-runtime.js --extension-dir . \
//     --write-continuity-fixture test/fixtures/codex-code-mode-continuity-sanitized.jsonl
//
// What was measured, 2026-10-13, and what each test below leans on:
//   - a cell left running at the end of a turn survives into the next turn of the
//     same process (also across a same-process thread/resume, and after
//     thread/unsubscribe), and allocation continues: 1, then 2;
//   - a resume into a NEW process (app-server thread/resume with or without
//     overrides, `codex exec resume`) appends to the same file with no new
//     session_meta and restarts allocation at 1, so one (session, cell ID) names
//     two cells in one file. A cell left running at the restart is gone, and a
//     wait for it gets the runtime's own "Script failed" / "Script error: exec
//     cell N not found" -- which the parser used to bind as that cell's failure;
//   - thread/fork writes a new file, one session_meta with forked_from_id and none
//     of the parent's items, and allocates from 1; the parent continues its own
//     sequence; a wait in the fork for the parent's open cell is "not found";
//   - event_msg/thread_settings_applied is written at every reload, AND at a
//     same-process turn whose turn/start carries setting overrides, across which a
//     running cell survived: so it is not a reload marker the join could key on;
//   - the runtime does not keep a finished cell: waiting on one is "not found";
//   - a script's thrown Error is written with "Error: " and a stack line; a thrown
//     bare string is written exactly as the runtime's not-found.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCodexJsonl, scanHistoryFiles } = require('../src/history-adapters');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-code-mode-continuity-sanitized.jsonl');
const TEXT = fs.readFileSync(FIXTURE, 'utf8');
const RECORDS = TEXT.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const FILE = 'C:\\src\\example\\rollout.jsonl';

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
const partsText = (output) => (Array.isArray(output) ? output.map((part) => part.text).join('\n') : String(output));
const edited = (record, change) => ({ ...record, payload: change({ ...record.payload }) });
const outputs = (records) => records.filter((record) => ['custom_tool_call_output', 'function_call_output'].includes(record.payload?.type));
const yields = (records) => outputs(records).filter((record) => record.payload.type === 'custom_tool_call_output')
  .map((record) => /^Script running with cell ID (\S+)\n/.exec(partsText(record.payload.output))?.[1]).filter(Boolean);
const NOT_FOUND = /^Script failed\n[^\n]*\nOutput:\n\nScript error:\nexec cell (\S+) not found$/;
const notFound = (records) => outputs(records).filter((record) => record.payload.type === 'function_call_output'
  && NOT_FOUND.test(partsText(record.payload.output)));
const settingsApplied = (records) => records.filter((record) => record.type === 'event_msg' && record.payload.type === 'thread_settings_applied');

// What each cell truly did, and the verdict the parser must reach: the cell's own
// outcome, or `unknown` where it has none (killed with its runtime), or where the
// join withholds by rule (two open cells under one key).
const VERDICTS = {
  'across-turns/A': { call_cell_1: 'success', call_cell_2: 'success' },
  'resumed-same-process/A': { call_cell_1: 'success', call_cell_2: 'success' },
  'unsubscribed-resume/A': { call_cell_1: 'success', call_cell_2: 'success' },
  'resumed/A': { call_cell_1: 'success', call_cell_2: 'success', call_cell_3: 'success' },
  'resumed-bare/A': { call_cell_1: 'success', call_cell_2: 'success' },
  'resumed-open-cell/A': { call_cell_1: 'unknown', call_cell_2: 'success' },
  'resumed-reallocated/A': { call_cell_1: 'unknown', call_cell_2: 'success' },
  'resumed-reused-id/A': { call_cell_1: 'unknown', call_cell_2: 'unknown' },
  'exec-resumed/A': { call_cell_1: 'success', call_cell_2: 'success', call_cell_3: 'success' },
  'exec-resumed-open-cell/A': { call_cell_1: 'unknown', call_cell_2: 'success' },
  'forked/A': { call_cell_1: 'success', call_cell_2: 'success', call_cell_4: 'success' },
  'forked/B': { call_cell_3: 'success' },
  'forked-open-cell/A': { call_cell_1: 'unknown' },
  'forked-open-cell/B': { call_cell_2: 'success' },
  'turn-overrides/A': { call_cell_1: 'success', call_cell_2: 'success' },
  'completed-then-waited/A': { call_cell_1: 'success' },
  'thrown-not-found/A': { call_cell_1: 'failed' },
  'thrown-string/A': { call_cell_1: 'unknown' },
};

test('the fixture really holds the measured continuity shapes', () => {
  assert.deepEqual([...SEGMENTS.keys()], Object.keys(VERDICTS), 'every measured thread, in case order');
  for (const [key, records] of SEGMENTS) {
    assert.equal(records[0].payload.cli_version, '0.161.0', `${key} names the build it came from`);
    assert.equal(records.filter((record) => record.type === 'session_meta').length, 1, `${key}: WITNESS one session_meta per rollout, resumed or not`);
  }
  // Allocation, by the IDs the yields name, in record order.
  assert.deepEqual(yields(segment('across-turns/A')), ['1', '2'], 'WITNESS allocation continues across a same-process turn');
  assert.deepEqual(yields(segment('resumed-same-process/A')), ['1', '2']);
  assert.deepEqual(yields(segment('unsubscribed-resume/A')), ['1', '2']);
  assert.deepEqual(yields(segment('resumed/A')), ['1', '2', '1'], 'WITNESS a resume into a new process restarts allocation in the same file');
  assert.deepEqual(yields(segment('resumed-bare/A')), ['1', '1']);
  assert.deepEqual(yields(segment('exec-resumed/A')), ['1', '2', '1'], 'WITNESS so does codex exec resume');
  assert.deepEqual(yields(segment('forked/A')), ['1', '2', '3'], 'WITNESS the parent continues its own sequence after a fork');
  assert.deepEqual(yields(segment('forked/B')), ['1'], 'WITNESS the fork allocates from 1');
  // The runtime's own "not found", and where it appears.
  for (const key of ['resumed-open-cell/A', 'resumed-reallocated/A', 'exec-resumed-open-cell/A', 'forked-open-cell/B', 'completed-then-waited/A']) {
    const found = notFound(segment(key));
    assert.equal(found.length, 1, `${key}: WITNESS the wait for the earlier cell was answered "not found"`);
    assert.deepEqual(found[0].payload.output.map((part) => part.text),
      ['Script failed\nWall time 1.0 seconds\nOutput:\n', 'Script error:\nexec cell 1 not found'], `${key}: the exact two-part shape`);
  }
  for (const key of ['across-turns/A', 'resumed-same-process/A', 'unsubscribed-resume/A', 'turn-overrides/A']) {
    const waits = segment(key).filter((record) => record.payload?.type === 'function_call' && record.payload.name === 'wait');
    assert.match(partsText(outputs(segment(key)).find((record) => record.payload.call_id === waits[0].payload.call_id).payload.output),
      /^Script completed\n/, `${key}: WITNESS the cell from the earlier turn was still there`);
  }
  // A reload writes thread_settings_applied; a settings change without one does too.
  for (const key of ['resumed/A', 'resumed-bare/A', 'resumed-open-cell/A', 'forked/B', 'turn-overrides/A']) {
    assert.equal(settingsApplied(segment(key)).length, 1, `${key}: WITNESS one thread_settings_applied`);
  }
  assert.equal(settingsApplied(segment('exec-resumed/A')).length, 2);
  for (const key of ['across-turns/A', 'resumed-same-process/A', 'unsubscribed-resume/A', 'forked/A']) {
    assert.equal(settingsApplied(segment(key)).length, 0, `${key}: WITNESS no thread_settings_applied without a reload or a settings change`);
  }
  const overrides = segment('turn-overrides/A').filter((record) => record.type === 'turn_context').map((record) => record.payload.model);
  assert.deepEqual(overrides, ['example-model', 'example-model-override'], 'WITNESS the second turn carried setting overrides');
  // The fork names its parent, and copies none of its items.
  assert.equal(segment('forked/B')[0].payload.forked_from_id, segment('forked/A')[0].payload.id);
  assert.equal(segment('forked/B').some((record) => ['call_cell_1', 'call_cell_2'].includes(record.payload?.call_id)), false,
    'WITNESS the fork carries none of the parent\'s calls');
  // How a script's own throw is written.
  const thrown = (key) => outputs(segment(key)).filter((record) => record.payload.type === 'function_call_output').at(-1).payload.output;
  assert.match(thrown('thrown-not-found/A')[1].text, /^Script error:\nError: exec cell 1 not found\n {4}at /, 'WITNESS a thrown Error carries its type and a stack');
  assert.deepEqual(thrown('thrown-string/A').map((part) => part.text), ['Script failed\nWall time 1.0 seconds\nOutput:\n', 'Script error:\nexec cell 1 not found'],
    'WITNESS a thrown string is written exactly as the runtime\'s not-found');
});

test('every measured cell carries its true outcome or none, alone and in one file with the rest', () => {
  for (const [key, expected] of Object.entries(VERDICTS)) assert.deepEqual(statuses(segment(key)), expected, key);
  // The whole fixture at once: every segment reuses call_cell_1.., under its own
  // session, which call groups and cell IDs are both scoped by.
  const sessionOf = new Map([...SEGMENTS].map(([key, records]) => [records[0].payload.id, key]));
  const whole = {};
  for (const item of parse(RECORDS)) (whole[sessionOf.get(item.session)] ??= {})[item.callId] = item.status;
  assert.deepEqual(whole, VERDICTS);
});

// THE DEFECT, on the real records: the runtime's "not found" bound as the open
// cell's terminal result read "Script failed", and credited a cell whose command
// had been killed with its runtime with a failure.
test('a wait across a reload is the runtime saying the cell is gone, never the cell\'s failure', () => {
  for (const key of ['resumed-open-cell/A', 'resumed-reallocated/A', 'exec-resumed-open-cell/A']) {
    const records = segment(key);
    const [answer] = notFound(records);
    assert.equal(statuses(records).call_cell_1, 'unknown', `${key}: the stopped cell has no outcome`);
    // Control: the same record as an ordinary script failure is still a failure.
    const failure = records.map((record) => (record !== answer ? record : edited(record, (payload) => ({ ...payload,
      output: [payload.output[0], { ...payload.output[1], text: 'Script error:\nError: exec cell 1 not found\n    at exec_main.mjs:2:7' }] }))));
    assert.equal(statuses(failure).call_cell_1, 'failed', `${key}: control, a thrown Error is the cell's own failure`);
  }
});

// The not-found answer is recognised or not; two observables show which. For a
// cell the file never yielded (the fork waiting on its parent's cell), the answer
// asks for no widen while an ordinary result for an unseen cell does; and for an
// open cell, the answer closes it with nothing applied while an ordinary "Script
// failed" result credits it with a failure.
test('only the exact not-found shape, for the ID the wait named, is the runtime\'s answer', () => {
  const variants = [
    ['another cell\'s ID', (output) => [output[0], { ...output[1], text: 'Script error:\nexec cell 7 not found' }]],
    ['a third part beside it', (output) => [...output, { type: 'input_text', text: '{"exit_code":0,"output":"x"}' }]],
    ['under "Script completed"', (output) => [{ ...output[0], text: output[0].text.replace('Script failed', 'Script completed') }, output[1]]],
    ['stdout below Output:', (output) => [{ ...output[0], text: `${output[0].text}stray stdout\n` }, output[1]]],
    ['one string, not two parts', (output) => output.map((part) => part.text).join('')],
    ['the line with trailing text', (output) => [output[0], { ...output[1], text: `${output[1].text} (retry)` }]],
    ['a thrown Error\'s spelling', (output) => [output[0], { ...output[1], text: 'Script error:\nError: exec cell 1 not found\n    at exec_main.mjs:2:7' }]],
  ];
  const replace = (records, change) => {
    const [answer] = notFound(records);
    return records.map((record) => (record !== answer ? record : edited(record, (payload) => ({ ...payload, output: change(payload.output) }))));
  };
  const fork = segment('forked-open-cell/B');
  assert.equal(parse(fork)._codexUnmatchedWaits.length, 0, 'control: the real answer asks for nothing');
  for (const [label, change] of variants) {
    assert.equal(parse(replace(fork, change))._codexUnmatchedWaits.length, 1, `${label}: not the runtime's answer, so an unseen cell's result asks for the widen`);
  }
  const resumed = segment('resumed-open-cell/A');
  assert.equal(statuses(resumed).call_cell_1, 'unknown', 'control: the real answer closes the stopped cell with nothing');
  for (const [label, change] of variants.filter(([label]) => label !== 'under "Script completed"')) {
    assert.equal(statuses(replace(resumed, change)).call_cell_1, 'failed', `${label}: an ordinary "Script failed" result is the cell's failure`);
  }
  // The cell's OWN output in that shape is a cell result, not a wait's answer.
  const [answer] = notFound(resumed);
  const own = resumed.find((record) => record.payload?.type === 'custom_tool_call_output' && record.payload.call_id === 'call_cell_1');
  const swapped = resumed.map((record) => (record !== own ? record : edited(record, (payload) => ({ ...payload, output: answer.payload.output }))));
  assert.equal(statuses(swapped).call_cell_1, 'failed', 'the shape is an answer only as a wait\'s result');
});

test('after a not-found the new runtime\'s cell binds as itself; before one, two open cells withhold both', () => {
  // The runtime answered "not found" for the old cell first, so the new cell under
  // the same ID is the only open one, and binds.
  assert.deepEqual(statuses(segment('resumed-open-cell/A')), { call_cell_1: 'unknown', call_cell_2: 'success' });
  // Nothing waited on the old cell, and the new runtime handed its ID to a new
  // cell: two open cells, one key, both withheld -- the coverage the ambiguity
  // rule gives up, never a credit to the wrong cell.
  assert.deepEqual(statuses(segment('resumed-reused-id/A')), { call_cell_1: 'unknown', call_cell_2: 'unknown' });
  assert.deepEqual(yields(segment('resumed-reused-id/A')), ['1', '1'], 'precondition: one ID, two cells');
  // And a closed cell never collides: a resumed session whose cells all finished reads exactly.
  assert.deepEqual(statuses(segment('resumed/A')), { call_cell_1: 'success', call_cell_2: 'success', call_cell_3: 'success' });
});

test('a not-found for a cell this file never yielded asks for no widen', () => {
  for (const key of ['forked-open-cell/B', 'completed-then-waited/A']) {
    assert.deepEqual(parse(segment(key))._codexUnmatchedWaits, [], `${key}: nothing a wider slice could find`);
  }
  // Control: an ordinary result for an unyielded ID is still reported, as before.
  const records = segment('forked-open-cell/B');
  const [answer] = notFound(records);
  const completed = records.map((record) => (record !== answer ? record : edited(record, (payload) => ({ ...payload,
    output: [{ ...payload.output[0], text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' }, { ...payload.output[1], text: 'done' }] }))));
  assert.equal(parse(completed)._codexUnmatchedWaits.length, 1, 'control: a completion for an unseen cell asks for the widen');
});

// THE APPEND-SLICE IDENTITY RULE (9abc330) across a resume boundary: cut at the
// boundary and just before the not-found answer, through the overlap and through
// the bounded widen, the latest verdict per id equals a full read's.
test('append slices across a resume boundary reach the full-read ids and verdicts', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-code-mode-continuity-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  let directory = 0;
  const scan = (records, cut, overlapBytes) => {
    const file = path.join(root, `case-${directory += 1}`, 'rollout.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl(records.slice(0, cut)));
    const first = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], overlapBytes });
    fs.appendFileSync(file, jsonl(records.slice(cut)));
    const second = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], cursors: first.cursors, overlapBytes });
    return { first, second, file };
  };
  // resumed-reused-id agrees only through an overlap that reaches the old cell's
  // yield; a narrower slice is the bounded exception pinned below.
  for (const [key, overlaps] of [['resumed/A', [256 * 1024, 1]], ['resumed-open-cell/A', [256 * 1024, 1]],
    ['exec-resumed-open-cell/A', [256 * 1024, 1]], ['resumed-reused-id/A', [256 * 1024]]]) {
    const records = segment(key);
    const { first } = scan(records, records.length, 1);
    const full = new Map(first.observations.map((item) => [item.id, [item.callId, item.status]]));
    assert.deepEqual(Object.fromEntries([...full.values()]), VERDICTS[key], `${key}: precondition, the full read`);
    const boundary = records.indexOf(settingsApplied(records)[0]);
    const answer = notFound(records)[0];
    for (const cut of [boundary, boundary + 1, ...(answer ? [records.indexOf(answer)] : [])]) {
      for (const overlapBytes of overlaps) {
        const { first: before, second } = scan(records, cut, overlapBytes);
        assert.equal(second.files[0].mode, 'append');
        assert.equal(second.files[0].unmatchedResults, undefined, `${key} cut ${cut} overlap ${overlapBytes}: nothing left unmatched`);
        const latest = new Map();
        for (const item of [...before.observations, ...second.observations]) latest.set(item.id, [item.callId, item.status]);
        assert.deepEqual(latest, full, `${key} cut ${cut} overlap ${overlapBytes}: the full-read ids and verdicts`);
      }
    }
  }
  // THE ONE BOUNDED EXCEPTION, in its measured shape: a slice that starts after
  // the old cell's yield cannot see that cell, so the new cell under its ID is the
  // only open one there and binds -- to its own true outcome (it did succeed),
  // where the full read withholds. Never the opposite, and the same id.
  const records = segment('resumed-reused-id/A');
  const call = records.find((record) => record.payload?.type === 'custom_tool_call' && record.payload.call_id === 'call_cell_2');
  const { second, file } = scan(records, records.indexOf(call) + 1, Buffer.byteLength(JSON.stringify(call)) + 2);
  assert.ok(second.files[0].bytesRead < fs.statSync(file).size, 'precondition: the slice starts past the old cell\'s yield');
  const sliced = second.observations.find((item) => item.callId === 'call_cell_2');
  const fullRead = parse(records).find((item) => item.callId === 'call_cell_2');
  assert.deepEqual([sliced.id, sliced.status], [fullRead.id, 'success'], 'the slice credits the new cell with its own outcome, under the full-read id');
  assert.equal(fullRead.status, 'unknown', 'where the full read withholds');
});

// THE SANITIZATION GATE, as for the other real-rollout fixtures.
test('the continuity fixture leaks nothing about the machine that produced it', () => {
  const lower = TEXT.toLowerCase();
  const username = (os.userInfo().username || '').toLowerCase();
  const hostname = (os.hostname() || '').toLowerCase();
  if (username.length >= 3) assert.equal(lower.includes(username), false, 'the fixture names the current user');
  if (hostname.length >= 3) assert.equal(lower.includes(hostname), false, 'the fixture names this machine');
  for (const marker of ['users\\\\', 'users/', '/home/', 'appdata', 'temp\\\\', '/tmp/', 'onedrive', '~1', 'agents.md', 'win_devtools',
    'acolyte-code-mode-', 'instructions>']) {
    if (marker === 'acolyte-code-mode-') {
      assert.equal(lower.replace(/acolyte-code-mode-witness/g, '').includes(marker), false, 'the fixture names a harness temp tree');
      continue;
    }
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  for (const marker of ['accent' + 'ure', '.ai-work', 'ai-platform', 'grimoire']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  const kinds = new Set(RECORDS.map((record) => [record.type, record.payload?.type].filter(Boolean).join('/')));
  assert.deepEqual([...kinds].sort(), ['event_msg/task_complete', 'event_msg/thread_settings_applied', 'response_item/custom_tool_call',
    'response_item/custom_tool_call_output', 'response_item/function_call', 'response_item/function_call_output', 'session_meta', 'turn_context'],
  'only the record kinds the tests read survive');
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
  assert.ok(paths >= 40, `WITNESS the path scan found ${paths} absolute paths to check`);
});
