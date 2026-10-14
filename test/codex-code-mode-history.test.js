'use strict';

// CODE-MODE CELLS, COMPLETED AND CONTINUED, IN THE STRUCTURE CODEX 0.161.0 WRITES.
//
// The fixture is a sanitized copy of ONE real fresh-session rollout produced on
// 2026-10-13 by scripts/check-codex-code-mode-runtime.js (codex-cli 0.161.0,
// Windows, `code_mode` enabled only in the harness's temporary CODEX_HOME,
// scripted loopback provider). That session ran six `exec` cells in order:
//
//   call_cell_1  finishes inside its yield window, nested command exits 0
//   call_cell_2  finishes inside its yield window, nested command exits nonzero
//   call_cell_3  yields ("Script running with cell ID 3"), then `wait` returns
//                the completion with exit 0
//   call_cell_4  yields, then `wait` returns the completion with a nonzero exit
//   call_cell_5  yields, two waits yield AGAIN with the same text, and a third
//                returns the completion with exit 0
//   call_cell_6  yields, then `wait` with `terminate: true` stops it: "Script
//                terminated". Its command would have exited 0.
//
// Cells 1-4 are byte-identical to the fixture's first version (wave c1); 5 and 6
// were added with the join. Three harness runs wrote byte-identical files.
// Regenerate with:
//   node scripts/check-codex-code-mode-runtime.js --extension-dir . \
//     --write-fixture test/fixtures/codex-code-mode-rollout-sanitized.jsonl
//
// The real facts the record shapes carry, and the tests below lean on each:
//   - the continuation result is a FUNCTION_CALL_OUTPUT of the `wait` call,
//     keyed by the wait's own call_id, not a custom_tool_call_output of the cell;
//     the only link back to the cell is the cell ID in the yield text and in the
//     wait arguments;
//   - a wait that yields again writes the same header as the cell's own yield;
//   - cell IDs are allocated per session in order, completed cells included
//     (1..6 here), so a cell ID alone does not name a cell across sessions.
//
// THE JOIN (src/history-adapters.js, codeModeJoin, 2026-10-13) replaces the
// bounded limit this file used to pin: continued cells now carry the outcome
// their wait reported, a terminated cell carries none, and every ambiguity is
// withheld. The safety property beside it -- a cell gets its true outcome or is
// withheld, never the opposite -- is unchanged and still holds on the derived
// interleavings.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCodexJsonl, scanHistoryFiles } = require('../src/history-adapters');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-code-mode-rollout-sanitized.jsonl');
const TEXT = fs.readFileSync(FIXTURE, 'utf8');
const RECORDS = TEXT.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const ITEMS = RECORDS.filter((record) => record.type === 'response_item').map((record) => record.payload);
// `null`: the cell has no outcome to be true to. Withholding is the only right answer.
const TRUE_OUTCOME = { call_cell_1: 'success', call_cell_2: 'failed', call_cell_3: 'success', call_cell_4: 'failed',
  call_cell_5: 'success', call_cell_6: null };
const OPPOSITE = { success: 'failed', failed: 'success' };

function partsText(output) {
  return Array.isArray(output) ? output.map((part) => part.text).join('\n') : String(output);
}

const jsonl = (records) => records.map((record) => JSON.stringify(record)).join('\n') + '\n';

function verdicts(text = TEXT) {
  return Object.fromEntries(parseCodexJsonl(text, { file: FIXTURE, platform: 'win32' })
    .map((observation) => [observation.callId, observation]));
}

function statuses(records) {
  return Object.fromEntries(Object.entries(verdicts(jsonl(records))).map(([callId, observation]) => [callId, observation.status]));
}

const find = (type, callId) => RECORDS.find((record) => record.payload?.type === type && record.payload?.call_id === callId);
const waitsFor = (cellId) => RECORDS.filter((record) => record.payload?.type === 'function_call' &&
  record.payload?.name === 'wait' && JSON.parse(record.payload.arguments).cell_id === cellId);
const outputOf = (wait) => find('function_call_output', wait.payload.call_id);
// A real record with its payload changed, everything else as Codex wrote it.
const edited = (record, change) => ({ ...record, payload: change({ ...record.payload }) });
const without = (...drop) => RECORDS.filter((record) => !drop.includes(record));
const replaced = (target, replacement) => RECORDS.map((record) => (record === target ? replacement : record));

// The precondition, as real assertions: every parser assertion below is vacuous
// if the fixture stopped containing a continued cell.
test('the fixture really contains completed, continued, re-waited and terminated code-mode cells', () => {
  const meta = RECORDS.find((record) => record.type === 'session_meta').payload;
  assert.equal(meta.cli_version, '0.161.0', 'the fixture names the build it came from');
  const cells = ITEMS.filter((item) => item.type === 'custom_tool_call' && item.name === 'exec');
  assert.deepEqual(cells.map((cell) => cell.call_id), Object.keys(TRUE_OUTCOME));
  for (const cell of cells) assert.match(cell.input, /tools\.exec_command\(\{ cmd: "/, `${cell.call_id} calls the nested shell tool`);

  const yields = ITEMS.filter((item) => item.type === 'custom_tool_call_output' && /^Script running with cell ID/.test(partsText(item.output)));
  assert.deepEqual(yields.map((item) => item.call_id), ['call_cell_3', 'call_cell_4', 'call_cell_5', 'call_cell_6'], 'WITNESS four cells yielded');
  // Allocation is per session and in order, completed cells included.
  assert.deepEqual(yields.map((item) => /cell ID (\S+)/.exec(partsText(item.output))[1]), ['3', '4', '5', '6']);
  for (const cellId of ['3', '4', '5']) {
    const last = waitsFor(cellId).at(-1);
    assert.match(partsText(outputOf(last).payload.output), /^Script completed/, `the last wait for cell ${cellId} carries the completion`);
    assert.match(partsText(outputOf(last).payload.output), /"exit_code":\d+/, 'and the nested exit code');
  }
  const again = waitsFor('5').slice(0, -1).map((wait) => partsText(outputOf(wait).payload.output));
  assert.ok(again.length >= 1, 'WITNESS a wait for cell 5 yielded again');
  for (const text of again) assert.match(text, /^Script running with cell ID 5\n/, 'a repeated yield has the yield header');
  const [stop] = waitsFor('6');
  assert.equal(JSON.parse(stop.payload.arguments).terminate, true, 'WITNESS cell 6 was stopped by wait');
  assert.match(partsText(outputOf(stop).payload.output), /^Script terminated\n/);
});

test('a code-mode cell that completes in its own window carries its own outcome', () => {
  const byCall = verdicts();
  assert.equal(byCall.call_cell_1.status, 'success');
  assert.equal(byCall.call_cell_2.status, 'failed', 'a nonzero nested exit is negative evidence');
  assert.equal(byCall.call_cell_1.command, 'node "C:/src/example/cell-1.cjs"');
  // The wait calls are orchestration, not shell: they produce no observation.
  assert.equal(Object.keys(byCall).some((callId) => callId.startsWith('call_wait_')), false);
  assert.equal(Object.keys(byCall).length, 6, 'one observation per cell, none per wait');
});

function assertNeverOpposite(byCall, label) {
  for (const [callId, truth] of Object.entries(TRUE_OUTCOME)) {
    if (!byCall[callId]) continue;
    const status = byCall[callId].status;
    if (truth === null) { assert.equal(status, 'unknown', `${label}: ${callId} has no outcome and read as ${status}`); continue; }
    assert.notEqual(status, OPPOSITE[truth],
      `${label}: ${callId} actually ${truth === 'success' ? 'succeeded' : 'failed'} and must not be read as ${OPPOSITE[truth]}`);
    assert.ok([truth, 'unknown'].includes(status), `${label}: ${callId} read as ${status}`);
  }
}

// The same real records, reordered so BOTH continued cells yield before either
// wait, and the wait for cell 3 comes first. Nothing is edited, only moved:
// each wait still names its own cell and carries its own completion. In the
// recorded session each wait directly follows its own yield, so a reader that
// bound a completion to "the cell that yielded last" would be right there by
// luck; here it would hand cell 3's success to cell 4.
function interleavedContinuations({ waitForFour = true } = {}) {
  const [three] = waitsFor('3');
  const [four] = waitsFor('4');
  return [RECORDS[0], RECORDS[1],
    find('custom_tool_call', 'call_cell_3'), find('custom_tool_call_output', 'call_cell_3'),
    find('custom_tool_call', 'call_cell_4'), find('custom_tool_call_output', 'call_cell_4'),
    three, outputOf(three),
    ...(waitForFour ? [four, outputOf(four)] : []),
  ];
}

// The property that has to hold whatever the coverage is. A reader that joins
// wait results back to the cell they name passes this; one that guesses fails.
test('a continued cell is credited with its true outcome or withheld, never the opposite', () => {
  assertNeverOpposite(verdicts(), 'recorded order');
  const crossed = interleavedContinuations();
  assert.equal(crossed.length, 10, 'precondition: every moved record was found');
  const byCall = verdicts(jsonl(crossed));
  assert.deepEqual(Object.keys(byCall).sort(), ['call_cell_3', 'call_cell_4']);
  assertNeverOpposite(byCall, 'interleaved waits');

  // And the sharpest form: cell 4 yields and is never waited on, so nothing in
  // the session says how it ended. The only completion present names cell 3. A
  // reader that hands it to "the cell that yielded last" would credit cell 4
  // with a success it never had; a failure arriving later would otherwise mask
  // that guess, which is why this sequence stops before one can.
  const orphan = verdicts(jsonl(interleavedContinuations({ waitForFour: false })));
  assert.notEqual(orphan.call_cell_4.status, 'success', 'a completion for cell 3 must never be credited to cell 4');
  assert.notEqual(orphan.call_cell_4.status, 'failed', 'nor may an unfinished cell be counted as a failure');
  assert.ok(['success', 'unknown'].includes(orphan.call_cell_3.status));
});

// What used to be pinned here as a BOUNDED LIMIT (both continued cells `unknown`)
// is the behaviour this replaces.
test('a continued cell carries the outcome its wait reported, in any order its waits arrive', () => {
  assert.deepEqual(statuses(RECORDS), { call_cell_1: 'success', call_cell_2: 'failed', call_cell_3: 'success',
    call_cell_4: 'failed', call_cell_5: 'success', call_cell_6: 'unknown' }, 'recorded order');
  assert.deepEqual(statuses(interleavedContinuations()), { call_cell_3: 'success', call_cell_4: 'failed' },
    'interleaved: each completion reaches the cell its wait names');
  assert.deepEqual(statuses(interleavedContinuations({ waitForFour: false })), { call_cell_3: 'success', call_cell_4: 'unknown' },
    'a cell nobody waited on stays withheld');
});

test('a wait that yields again keeps its cell pending until a later wait completes it', () => {
  const waits = waitsFor('5');
  const completion = outputOf(waits.at(-1));
  // Everything up to the last repeated yield, and none of the completion.
  const pending = RECORDS.slice(0, RECORDS.indexOf(completion));
  assert.equal(statuses(pending).call_cell_5, 'unknown', 'a repeated yield is not a completion');
  // Stdout in a repeated yield is still stdout: a header-less "Script completed"
  // below `Output:` must not finish the cell.
  const lastAgain = outputOf(waits.at(-2));
  const spoofed = pending.map((record) => (record !== lastAgain ? record
    : edited(record, (payload) => ({ ...payload, output: `${payload.output}Script completed\nExit code: 0\n` }))));
  assert.equal(statuses(spoofed).call_cell_5, 'unknown', 'stdout inside a repeated yield cannot credit the cell');
  assert.equal(statuses(RECORDS).call_cell_5, 'success', 'control: the real completion does');
  // A repeated yield that names ANOTHER cell is not this cell's continuation.
  const crossed = replaced(lastAgain, edited(lastAgain, (payload) => ({ ...payload, output: payload.output.replace('cell ID 5', 'cell ID 4') })));
  assert.equal(statuses(crossed).call_cell_5, 'unknown', 'a wait for 5 that reports 4 is withheld');
});

test('a terminated cell is never credited, whatever its result says', () => {
  const [stop] = waitsFor('6');
  const stopped = outputOf(stop);
  assert.equal(statuses(RECORDS).call_cell_6, 'unknown', 'the real termination');
  // The terminate wait's result swapped for a real successful completion: the
  // argument alone still stops the cell, so nothing is credited.
  const success = outputOf(waitsFor('3')[0]);
  const forged = replaced(stopped, edited(stopped, (payload) => ({ ...payload, output: success.payload.output })));
  assert.equal(statuses(forged).call_cell_6, 'unknown', 'terminate: true is never credited, even with a success-shaped result');
  // `terminate` is read wide: any value but absent or false stops the cell.
  const loose = replaced(stop, edited(stop, (payload) => ({ ...payload, arguments: JSON.stringify({ cell_id: '6', terminate: 'true' }) })))
    .map((record) => (record === stopped ? edited(stopped, (payload) => ({ ...payload, output: success.payload.output })) : record));
  assert.equal(statuses(loose).call_cell_6, 'unknown', 'a string terminate is still a terminate');
  // And a plain wait whose result says "Script terminated" closes the cell the same way.
  const plain = replaced(stop, edited(stop, (payload) => ({ ...payload, arguments: JSON.stringify({ cell_id: '6', yield_time_ms: 10000 }) })));
  assert.equal(statuses(plain).call_cell_6, 'unknown', 'a termination result is never a completion');
  const boasting = plain.map((record) => (record !== stopped ? record
    : edited(stopped, (payload) => ({ ...payload, output: `${payload.output}Script completed\n` }))));
  assert.equal(statuses(boasting).call_cell_6, 'unknown', 'not even when the stopped script printed "Script completed"');
  // A wait after termination cannot resurrect the cell.
  const late = [...RECORDS.slice(0, -1),
    edited(waitsFor('3')[0], (payload) => ({ ...payload, call_id: 'call_wait_late', arguments: JSON.stringify({ cell_id: '6' }) })),
    edited(success, (payload) => ({ ...payload, call_id: 'call_wait_late' }))];
  assert.equal(statuses(late).call_cell_6, 'unknown', 'a closed cell stays closed');
});

test('an ambiguous or unyielded binding is withheld', () => {
  const [three] = waitsFor('3');
  // Two open cells claim ID 3: cell 4's real call and yield, its yield edited to
  // say 3, placed before the wait for 3. Neither can be told from the other.
  const twin = [RECORDS[0], RECORDS[1],
    find('custom_tool_call', 'call_cell_3'), find('custom_tool_call_output', 'call_cell_3'),
    find('custom_tool_call', 'call_cell_4'),
    edited(find('custom_tool_call_output', 'call_cell_4'), (payload) => ({ ...payload, output: payload.output.replace('cell ID 4', 'cell ID 3') })),
    three, outputOf(three)];
  assert.deepEqual(statuses(twin), { call_cell_3: 'unknown', call_cell_4: 'unknown' }, 'two open cells with one ID: both withheld');
  // A wait for an ID nobody yielded binds to nothing, and moves nothing else.
  const stray = replaced(three, edited(three, (payload) => ({ ...payload, arguments: JSON.stringify({ cell_id: '9', yield_time_ms: 10000 }) })));
  assert.deepEqual(statuses(stray), { ...statuses(RECORDS), call_cell_3: 'unknown' }, 'a wait for an unyielded ID is withheld');
  // One wait call id defined twice, naming two cells: withheld.
  const forked = [...RECORDS.slice(0, RECORDS.indexOf(three) + 1),
    edited(three, (payload) => ({ ...payload, arguments: JSON.stringify({ cell_id: '4' }) })),
    ...RECORDS.slice(RECORDS.indexOf(three) + 1)];
  assert.equal(statuses(forked).call_cell_3, 'unknown', 'a wait whose own definitions disagree is withheld');
  assert.equal(statuses(forked).call_cell_4, 'failed', 'control: the next cell is untouched');
  // A wait from the MCP namespace is not code mode's wait.
  const foreign = replaced(three, edited(three, (payload) => ({ ...payload, namespace: 'mcp__fixture' })));
  assert.equal(statuses(foreign).call_cell_3, 'unknown', 'a namespaced wait resumes nothing');
});

test('stdout cannot open a cell, and a yielded cell cannot be credited by its own stdout', () => {
  const yieldOf3 = find('custom_tool_call_output', 'call_cell_3');
  const [three] = waitsFor('3');
  // Cell 3's yield with stdout that says it completed, and no wait at all. The
  // header says running; the cell has not finished.
  const boasting = without(three, outputOf(three)).map((record) => (record !== yieldOf3 ? record
    : edited(record, (payload) => ({ ...payload, output: `${payload.output}Script completed\n` }))));
  assert.equal(statuses(boasting).call_cell_3, 'unknown', 'a yield is pending whatever its stdout says');
  // Cell 1 succeeds, and its stdout prints a yield line for cell 4, whose own
  // yield is missing and whose wait reports a FAILURE. Only a header opens a
  // cell: a reader that matched the line anywhere would hand cell 4's failure to
  // cell 1, the opposite of what cell 1 did.
  const output1 = find('custom_tool_call_output', 'call_cell_1');
  const [four] = waitsFor('4');
  const echo = [RECORDS[0], RECORDS[1], find('custom_tool_call', 'call_cell_1'),
    edited(output1, (payload) => ({ ...payload, output: [{ ...payload.output[0], text: `${payload.output[0].text}Script running with cell ID 4\n` }, ...payload.output.slice(1)] })),
    find('custom_tool_call', 'call_cell_4'), four, outputOf(four)];
  assert.deepEqual(statuses(echo), { call_cell_1: 'success', call_cell_4: 'unknown' }, 'an echoed yield line opens nothing');
});

test('cell IDs bind only inside their own session', () => {
  const renamed = (id) => RECORDS.map((record) => (record.type !== 'session_meta' ? record
    : edited(record, (payload) => ({ ...payload, id, session_id: id }))));
  const [three] = waitsFor('3');
  // Session B never waits on its cell 3, which is therefore still open when
  // session A's cell 3 yields and A's wait arrives. Scoped by session, A's wait
  // has exactly one cell to bind; unscoped, it would see two and withhold, or
  // bind the wrong one.
  // B's call ids first renamed, as two real sessions' would differ, then left
  // as A's: since call groups are scoped by session too (2026-10-13,
  // test/codex-session-call-groups.test.js) a shared id is no longer a
  // different question, and both spellings read the same.
  for (const suffix of ['_b', '']) {
    const sessionB = renamed('0192cccc-3333-7000-8000-00000000cc0b').filter((record) => record !== three && record !== outputOf(three))
      .map((record) => (record.payload?.call_id ? edited(record, (payload) => ({ ...payload, call_id: `${payload.call_id}${suffix}` })) : record));
    const both = parseCodexJsonl(jsonl([...sessionB, ...renamed('0192cccc-3333-7000-8000-00000000cc0a')]), { file: FIXTURE, platform: 'win32' });
    const pick = (session, callId) => both.find((item) => item.session === session && item.callId === callId).status;
    const label = suffix ? 'renamed call ids' : 'shared call ids';
    assert.equal(pick('0192cccc-3333-7000-8000-00000000cc0a', 'call_cell_3'), 'success', label);
    assert.equal(pick('0192cccc-3333-7000-8000-00000000cc0b', `call_cell_3${suffix}`), 'unknown', `${label}: no wait in session B, no outcome in session B`);
    assert.equal(pick('0192cccc-3333-7000-8000-00000000cc0b', `call_cell_4${suffix}`), 'failed', label);
  }
});

// THE APPEND-SLICE IDENTITY RULE (9abc330): whatever bytes a scan starts from, a
// call keeps one identity and reaches the verdict a full read reaches. Here the
// join's state spans the cursor: the cell and its yield before it, the wait and
// its result after it, with an overlap that reaches the cell and one that does
// not, which has to go through the bounded reconcile widening.
test('a join that spans an append-slice boundary reaches the full-read verdict under the same identity', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-code-mode-append-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const full = (() => {
    const file = path.join(root, 'full', 'rollout.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl(RECORDS));
    return Object.fromEntries(scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [] }).observations
      .map((item) => [item.callId, [item.id, item.status]]));
  })();
  assert.equal(full.call_cell_3[1], 'success', 'precondition: the full read joins');
  const cuts = [
    ['after cell 3 yields', RECORDS.indexOf(find('custom_tool_call_output', 'call_cell_3')) + 1, 'call_cell_3'],
    ['between the wait for 3 and its result', RECORDS.indexOf(waitsFor('3')[0]) + 1, 'call_cell_3'],
    ['between two repeated yields of cell 5', RECORDS.indexOf(outputOf(waitsFor('5')[0])) + 1, 'call_cell_5'],
    ['after cell 6 yields, before it is stopped', RECORDS.indexOf(find('custom_tool_call_output', 'call_cell_6')) + 1, 'call_cell_6'],
  ];
  let directory = 0;
  for (const [label, cut, callId] of cuts) {
    for (const overlapBytes of [256 * 1024, 1]) {
      const file = path.join(root, `case-${directory += 1}`, 'rollout.jsonl');
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, jsonl(RECORDS.slice(0, cut)));
      const first = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], overlapBytes });
      fs.appendFileSync(file, jsonl(RECORDS.slice(cut)));
      const second = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], cursors: first.cursors, overlapBytes });
      assert.equal(second.files[0].mode, 'append', `${label}: precondition, the second scan is an append slice`);
      assert.equal(second.files[0].unmatchedResults, undefined, `${label} (overlap ${overlapBytes}): nothing left unmatched`);
      // Latest verdict per id across the two scans, the way the manager upserts.
      const latest = new Map();
      for (const item of [...first.observations, ...second.observations]) latest.set(item.id, [item.callId, item.status]);
      for (const [cellId, [id, status]] of Object.entries(full)) {
        assert.ok(latest.has(id), `${label} (overlap ${overlapBytes}): ${cellId} keeps its full-read identity`);
        assert.equal(latest.get(id)[1], status, `${label} (overlap ${overlapBytes}): ${cellId} reaches the full-read verdict`);
      }
      assert.equal(latest.size, Object.keys(full).length, `${label} (overlap ${overlapBytes}): no second identity for any cell`);
      if (TRUE_OUTCOME[callId]) {
        assert.ok(second.observations.some((item) => item.callId === callId && item.status === TRUE_OUTCOME[callId]),
          `${label} (overlap ${overlapBytes}): the appended result is delivered with the slice`);
      }
    }
  }
  // The overlap starts exactly at cell 3's yield, so the slice opens the cell but
  // holds neither its call nor anything else that is missing a call. Only the
  // join can ask for the widen here: its bound result has no group to land in.
  {
    const yieldRecord = find('custom_tool_call_output', 'call_cell_3');
    const cut = RECORDS.indexOf(yieldRecord) + 1;
    const overlapBytes = Buffer.byteLength(JSON.stringify(yieldRecord)) + 2;
    const file = path.join(root, 'yield-only', 'rollout.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, jsonl(RECORDS.slice(0, cut)));
    const first = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], overlapBytes });
    fs.appendFileSync(file, jsonl(RECORDS.slice(cut)));
    const narrow = parseCodexJsonl(jsonl(RECORDS.slice(cut - 1)), { file, platform: 'win32' });
    assert.equal(narrow.some((item) => item.callId === 'call_cell_3'), false, 'precondition: the slice from the yield holds no cell 3 call');
    const second = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], cursors: first.cursors, overlapBytes });
    assert.equal(second.files[0].unmatchedResults, undefined, 'the widen found the call');
    const cell = second.observations.find((item) => item.callId === 'call_cell_3');
    assert.ok(cell, 'cell 3 is delivered with the slice');
    assert.deepEqual([cell.id, cell.status], full.call_cell_3, 'under its full-read identity and verdict');
  }
  // With no reconcile budget the far-away cell cannot be reached: the result is
  // REPORTED unmatched and the cell is withheld, never guessed.
  const file = path.join(root, 'no-reconcile', 'rollout.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const cut = cuts[0][1];
  fs.writeFileSync(file, jsonl(RECORDS.slice(0, cut)));
  const first = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], overlapBytes: 1, reconcileBytes: 0 });
  fs.appendFileSync(file, jsonl(RECORDS.slice(cut)));
  const second = scanHistoryFiles({ codexRoots: [path.dirname(file)], claudeRoots: [], cursors: first.cursors, overlapBytes: 1, reconcileBytes: 0 });
  assert.ok(second.files[0].unmatchedResults >= 1, 'WITNESS the unreachable cell is reported, not dropped');
  assert.equal(second.observations.some((item) => item.callId === 'call_cell_3' && item.status !== 'unknown'), false,
    'and it is not credited from a slice that cannot see it');
});

// THE SANITIZATION GATE, as for the older fixture: a real path or machine name
// pushed to a public repository is not undoable by a later commit.
test('the code-mode fixture leaks nothing about the machine that produced it', () => {
  const lower = TEXT.toLowerCase();
  const username = (os.userInfo().username || '').toLowerCase();
  const hostname = (os.hostname() || '').toLowerCase();
  if (username.length >= 3) assert.equal(lower.includes(username), false, 'the fixture names the current user');
  if (hostname.length >= 3) assert.equal(lower.includes(hostname), false, 'the fixture names this machine');
  for (const marker of ['users\\\\', 'users/', '/home/', 'appdata', 'temp\\\\', '/tmp/', 'onedrive', '~1', 'agents.md', 'win_devtools']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  for (const marker of ['accent' + 'ure', '.ai-work', 'ai-platform', 'grimoire']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
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
  assert.ok(paths >= 8, `WITNESS the path scan found ${paths} absolute paths to check`);
});
