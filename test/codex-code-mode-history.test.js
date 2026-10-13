'use strict';

// CODE-MODE CELLS, COMPLETED AND CONTINUED, IN THE STRUCTURE CODEX 0.161.0 WRITES.
//
// The fixture is a sanitized copy of ONE real fresh-session rollout produced on
// 2026-10-13 by scripts/check-codex-code-mode-runtime.js (codex-cli 0.161.0,
// Windows, `code_mode` enabled only in the harness's temporary CODEX_HOME,
// scripted loopback provider). That session ran four `exec` cells in order:
//
//   call_cell_1  finishes inside its yield window, nested command exits 0
//   call_cell_2  finishes inside its yield window, nested command exits nonzero
//   call_cell_3  yields ("Script running with cell ID 3"), then `wait` returns
//                the completion with exit 0
//   call_cell_4  yields, then `wait` returns the completion with a nonzero exit
//
// Regenerate with:
//   node scripts/check-codex-code-mode-runtime.js --extension-dir . \
//     --write-fixture test/fixtures/codex-code-mode-rollout-sanitized.jsonl
//
// Two real facts the record shapes carry, and the tests below lean on both:
//   - the continuation result is a FUNCTION_CALL_OUTPUT of the `wait` call,
//     keyed by the wait's own call_id, not a custom_tool_call_output of the cell;
//     the only link back to the cell is the cell ID in the yield text and in the
//     wait arguments;
//   - cell IDs are allocated per session in order, completed cells included
//     (1..4 here), so a cell ID alone does not name a cell across sessions.
//
// BOUNDED LIMIT, 2026-10-13. The parser does not join a `wait` result back to
// its cell, so both continued cells stay `unknown`: no success is invented, and
// the nonzero continued run is not counted as a failure either. The test that
// pins that is labelled; when a reviewed join lands, its two expectations change
// to `success` and `failed` and the safety test beside it keeps holding.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCodexJsonl } = require('../src/history-adapters');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-code-mode-rollout-sanitized.jsonl');
const TEXT = fs.readFileSync(FIXTURE, 'utf8');
const RECORDS = TEXT.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));
const ITEMS = RECORDS.filter((record) => record.type === 'response_item').map((record) => record.payload);
const TRUE_OUTCOME = { call_cell_1: 'success', call_cell_2: 'failed', call_cell_3: 'success', call_cell_4: 'failed' };
const OPPOSITE = { success: 'failed', failed: 'success' };

function partsText(output) {
  return Array.isArray(output) ? output.map((part) => part.text).join('\n') : String(output);
}

function verdicts(text = TEXT) {
  return Object.fromEntries(parseCodexJsonl(text, { file: FIXTURE, platform: 'win32' })
    .map((observation) => [observation.callId, observation]));
}

// The precondition, as real assertions: every parser assertion below is vacuous
// if the fixture stopped containing a continued cell.
test('the fixture really contains completed and continued code-mode cells', () => {
  const meta = RECORDS.find((record) => record.type === 'session_meta').payload;
  assert.equal(meta.cli_version, '0.161.0', 'the fixture names the build it came from');
  const cells = ITEMS.filter((item) => item.type === 'custom_tool_call' && item.name === 'exec');
  assert.deepEqual(cells.map((cell) => cell.call_id), Object.keys(TRUE_OUTCOME));
  for (const cell of cells) assert.match(cell.input, /tools\.exec_command\(\{ cmd: "/, `${cell.call_id} calls the nested shell tool`);

  const yields = ITEMS.filter((item) => item.type === 'custom_tool_call_output' && /Script running with cell ID/.test(partsText(item.output)));
  assert.deepEqual(yields.map((item) => item.call_id), ['call_cell_3', 'call_cell_4'], 'WITNESS two cells yielded');
  for (const yielded of yields) {
    const cellId = /cell ID (\S+)/.exec(partsText(yielded.output))[1];
    const wait = ITEMS.find((item) => item.type === 'function_call' && item.name === 'wait' &&
      JSON.parse(item.arguments).cell_id === cellId);
    assert.ok(wait, `WITNESS a wait call resumes cell ${cellId}`);
    const done = ITEMS.find((item) => item.type === 'function_call_output' && item.call_id === wait.call_id);
    assert.match(partsText(done.output), /Script completed/, `the wait for cell ${cellId} carries the completion`);
    assert.match(partsText(done.output), /"exit_code":\d+/, 'and the nested exit code');
  }
  // Allocation is per session and in order, completed cells included.
  assert.deepEqual(yields.map((item) => /cell ID (\S+)/.exec(partsText(item.output))[1]), ['3', '4']);
});

test('a code-mode cell that completes in its own window carries its own outcome', () => {
  const byCall = verdicts();
  assert.equal(byCall.call_cell_1.status, 'success');
  assert.equal(byCall.call_cell_2.status, 'failed', 'a nonzero nested exit is negative evidence');
  assert.equal(byCall.call_cell_1.command, 'node "C:/src/example/cell-1.cjs"');
  // The wait calls are orchestration, not shell: they produce no observation.
  assert.equal(Object.keys(byCall).some((callId) => callId.startsWith('call_wait_')), false);
  assert.equal(Object.keys(byCall).length, 4, 'one observation per cell, none per wait');
});

function assertNeverOpposite(byCall, label) {
  for (const [callId, truth] of Object.entries(TRUE_OUTCOME)) {
    if (!byCall[callId]) continue;
    assert.notEqual(byCall[callId].status, OPPOSITE[truth],
      `${label}: ${callId} actually ${truth === 'success' ? 'succeeded' : 'failed'} and must not be read as ${OPPOSITE[truth]}`);
    assert.ok([truth, 'unknown'].includes(byCall[callId].status), `${label}: ${callId} read as ${byCall[callId].status}`);
  }
}

// The same real records, reordered so BOTH continued cells yield before either
// wait, and the wait for cell 3 comes first. Nothing is edited, only moved:
// each wait still names its own cell and carries its own completion. In the
// recorded session each wait directly follows its own yield, so a reader that
// bound a completion to "the cell that yielded last" would be right there by
// luck; here it would hand cell 3's success to cell 4.
function interleavedContinuations({ waitForFour = true } = {}) {
  const find = (type, callId) => RECORDS.find((record) => record.payload?.type === type && record.payload?.call_id === callId);
  const waitFor = (cellId) => RECORDS.find((record) => record.payload?.type === 'function_call' &&
    record.payload?.name === 'wait' && JSON.parse(record.payload.arguments).cell_id === cellId);
  const [three, four] = [waitFor('3'), waitFor('4')];
  return [RECORDS[0], RECORDS[1],
    find('custom_tool_call', 'call_cell_3'), find('custom_tool_call_output', 'call_cell_3'),
    find('custom_tool_call', 'call_cell_4'), find('custom_tool_call_output', 'call_cell_4'),
    three, find('function_call_output', three.payload.call_id),
    ...(waitForFour ? [four, find('function_call_output', four.payload.call_id)] : []),
  ].map((record) => JSON.stringify(record)).join('\n') + '\n';
}

// The property that has to hold whatever the coverage is. A reader that joins
// wait results back to the cell they name passes this; one that guesses fails.
test('a continued cell is credited with its true outcome or withheld, never the opposite', () => {
  assertNeverOpposite(verdicts(), 'recorded order');
  const crossed = interleavedContinuations();
  assert.equal(crossed.split('\n').filter(Boolean).length, 10, 'precondition: every moved record was found');
  const byCall = verdicts(crossed);
  assert.deepEqual(Object.keys(byCall).sort(), ['call_cell_3', 'call_cell_4']);
  assertNeverOpposite(byCall, 'interleaved waits');

  // And the sharpest form: cell 4 yields and is never waited on, so nothing in
  // the session says how it ended. The only completion present names cell 3. A
  // reader that hands it to "the cell that yielded last" would credit cell 4
  // with a success it never had; a failure arriving later would otherwise mask
  // that guess, which is why this sequence stops before one can.
  const orphan = verdicts(interleavedContinuations({ waitForFour: false }));
  assert.notEqual(orphan.call_cell_4.status, 'success', 'a completion for cell 3 must never be credited to cell 4');
  assert.notEqual(orphan.call_cell_4.status, 'failed', 'nor may an unfinished cell be counted as a failure');
  assert.ok(['success', 'unknown'].includes(orphan.call_cell_3.status));
});

// BOUNDED LIMIT (2026-10-13), pinned so it cannot change silently in either
// direction. See the header: the join from a `wait` result to its cell is not
// implemented, so both continued cells are withheld rather than guessed.
test('BOUNDED LIMIT: continued cells stay unknown until wait results are joined to their cell', () => {
  const byCall = verdicts();
  assert.equal(byCall.call_cell_3.status, 'unknown', 'continued success is withheld, not credited');
  assert.equal(byCall.call_cell_4.status, 'unknown', 'continued failure is withheld, not counted');
});

// THE SANITIZATION GATE, as for the older fixture: a real path or machine name
// pushed to a public repository is not undoable by a later commit.
test('the code-mode fixture leaks nothing about the machine that produced it', () => {
  const lower = TEXT.toLowerCase();
  const username = (os.userInfo().username || '').toLowerCase();
  const hostname = (os.hostname() || '').toLowerCase();
  if (username.length >= 3) assert.equal(lower.includes(username), false, 'the fixture names the current user');
  if (hostname.length >= 3) assert.equal(lower.includes(hostname), false, 'the fixture names this machine');
  for (const marker of ['users\\\\', 'users/', '/home/', 'appdata', 'temp\\\\', '/tmp/', 'onedrive', '~1']) {
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
  assert.ok(paths >= 6, `WITNESS the path scan found ${paths} absolute paths to check`);
});
