'use strict';

// ONE SANITIZED CODEX ROLLOUT, IN THE REAL STRUCTURE.
//
// Every other history test in this repo builds its own minimal record shapes,
// which means they all agree with each other about what Codex writes and none
// of them has ever been checked against what Codex actually writes. This fixture
// is the structure of a real rollout on the development box (codex-cli 0.145.0),
// with every VALUE replaced by a synthetic one:
//
//   top level   {timestamp, ordinal, type, payload}
//   payload     session_meta, turn_context, event_msg/task_started,
//               response_item/{message,reasoning}, response_item/custom_tool_call
//               (name "exec", input a generated JS snippet calling
//               tools.exec_command with a "cmd" property),
//               response_item/custom_tool_call_output (output is EITHER an array
//               of {type,text} parts OR a plain string -- both occur),
//               response_item/function_call for the agent-orchestration tools
//               (wait, spawn_agent, ...), token_usage_record, event_msg/task_complete
//
// THIS IS A PUBLIC REPOSITORY. Nothing from the real corpus is reproduced: no
// absolute path carrying a username, no machine name, no project name, no
// employer reference, and nothing from the real allow list. The last test in
// this file is the gate that keeps it that way.
//
// Measured against the real corpus while building this: 53 rollout files, 3,146
// custom_tool_call records, 2,426 observations, 47 files yielding at least one.
// That is the shape the health check below is calibrated against.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { parseCodexJsonl } = require('../src/history-adapters');

const FIXTURE = path.join(__dirname, 'fixtures', 'codex-rollout-sanitized.jsonl');
const TEXT = fs.readFileSync(FIXTURE, 'utf8');
const RECORDS = TEXT.split(/\r?\n/).filter((line) => line.trim()).map((line) => JSON.parse(line));

// "Looks like a shell call." Deliberately LOOSER than the reader: it matches any
// receiver, not just `tools`, so a rollout that renamed the object is caught
// rather than read as a session that ran nothing. That is the whole point --
// the failure this guards against is a corpus the parser walks straight past
// while reporting a clean scan.
const NESTED_CALL = /\b[A-Za-z_$][\w$]*\s*\.\s*(?:exec_command|shell_command)\s*\(/;

function shellCallLike(record) {
  const payload = record?.payload;
  if (!payload || typeof payload !== 'object') return null;
  const callId = payload.call_id || payload.callId || payload.id;
  if (payload.type === 'custom_tool_call' && typeof payload.input === 'string') {
    return NESTED_CALL.test(payload.input) ? { callId, why: 'nested exec_command/shell_command' } : null;
  }
  if (payload.type === 'function_call') {
    const raw = typeof payload.arguments === 'string' ? payload.arguments
      : typeof payload.input === 'string' ? payload.input : '';
    let args = null;
    try { args = JSON.parse(raw); } catch { args = null; }
    if (args && typeof args === 'object' &&
        (typeof args.command === 'string' || typeof args.cmd === 'string')) {
      return { callId, why: `function_call ${payload.name} carrying a command argument` };
    }
  }
  return null;
}

// The health verdict. A session with no shell-call-like records is chat-only and
// is a clean result, not an error; a session with records that LOOK like shell
// calls and produced nothing is a parser failure and has to say so.
function parserHealth(records, observations) {
  const seen = new Set(observations.map((observation) => observation.callId).filter(Boolean));
  const shellLike = [];
  const unread = [];
  for (const record of records) {
    const hit = shellCallLike(record);
    if (!hit) continue;
    shellLike.push(hit);
    if (!seen.has(hit.callId)) unread.push(hit);
  }
  return {
    shellLike: shellLike.length,
    unread,
    chatOnly: shellLike.length === 0,
    ok: unread.length === 0,
  };
}

test('the sanitized fixture correlates every call to its own output', () => {
  const observations = parseCodexJsonl(TEXT, { file: FIXTURE, platform: 'win32' });
  const byCommand = new Map(observations.map((observation) => [observation.command, observation]));

  assert.equal(observations.length, 5, `expected five observations, got ${observations.length}`);

  // A call whose output says exit 0 is a success, and the outcome came from the
  // OUTPUT record rather than from the call's own `status` field. Codex writes
  // `status: "completed"` on a call whose command failed, so trusting it would
  // turn every failure into evidence of success.
  assert.equal(byCommand.get('rg --files').status, 'success');
  assert.equal(byCommand.get('rg --files').callId, 'call_b1aaaa0000000001');

  // ...and the failing one is negative evidence, from an output record written
  // in the OTHER shape Codex uses: a plain string rather than an array of parts.
  assert.equal(byCommand.get('rg --nonexistent-flag').status, 'failed');
  assert.equal(byCommand.get('rg --nonexistent-flag').callId, 'call_b1aaaa0000000002');
  const failing = RECORDS.find((r) => r.payload?.call_id === 'call_b1aaaa0000000002' &&
    r.payload?.type === 'custom_tool_call_output');
  assert.equal(typeof failing.payload.output, 'string', 'the plain-string output shape is exercised');

  // ONE call, TWO commands, one shared outcome. The exporter refuses to credit
  // either command with a success it cannot attribute: a script that ran two
  // commands and exited 0 does not prove the first one worked.
  const first = byCommand.get('node --version');
  const second = byCommand.get('node --help');
  assert.equal(first.callId, second.callId, 'both commands carry the call that ran them');
  assert.equal(first.callId, 'call_b1aaaa0000000003');
  assert.equal(first.status, 'unknown');
  assert.equal(second.status, 'unknown');

  // An unanswered call correlates to nothing and stays unknown, so nothing
  // downstream can count it as a run.
  assert.equal(byCommand.get('git status').status, 'unknown');
  assert.equal(RECORDS.some((r) => r.payload?.type === 'custom_tool_call_output' &&
    r.payload?.call_id === 'call_b1aaaa0000000004'), false, 'the fixture really does omit that output');

  // The agent-orchestration function_call is not a shell call and produces
  // nothing. The real corpus is full of these.
  assert.equal(observations.some((observation) => observation.callId === 'call_b1aaaa0000000005'), false);
});

test('a shell-call-like record that yields nothing is a parser-health error', () => {
  const observations = parseCodexJsonl(TEXT, { file: FIXTURE, platform: 'win32' });
  const health = parserHealth(RECORDS, observations);
  assert.equal(health.chatOnly, false, 'this fixture runs commands, so chat-only would be wrong');
  assert.equal(health.shellLike, 4, 'four records look like shell calls');
  assert.deepEqual(health.unread, [], 'and the reader produced an observation for every one');
  assert.equal(health.ok, true);

  // THE FAILURE IT EXISTS TO CATCH. A rollout whose generated script calls the
  // same method on a DIFFERENT receiver is still a shell call to anyone reading
  // it, and the reader -- which looks for the identifier `tools` -- yields
  // nothing. Without this check that corpus reports as a clean scan of a session
  // that ran no commands, which is exactly what a silent regression looks like.
  const renamed = [
    JSON.stringify({ timestamp: '2026-09-24T12:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 's', cwd: 'C:\\src\\example' } }),
    JSON.stringify({
      timestamp: '2026-09-24T12:00:01.000Z', ordinal: 1, type: 'response_item',
      payload: {
        type: 'custom_tool_call', id: 'ctc_x', status: 'completed', call_id: 'call_x', name: 'exec',
        input: 'const r = await runtime.exec_command({"cmd":"rg --files"}); dump(r.output);',
      },
    }),
    JSON.stringify({
      timestamp: '2026-09-24T12:00:02.000Z', ordinal: 2, type: 'response_item',
      payload: { type: 'custom_tool_call_output', id: 'ctco_x', call_id: 'call_x', output: 'Exit code: 0\n' },
    }),
    '',
  ].join('\n');
  const renamedRecords = renamed.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const renamedObs = parseCodexJsonl(renamed, { file: 'renamed.jsonl', platform: 'win32' });
  assert.equal(renamedObs.length, 0, 'precondition: the reader really does miss this shape');
  const renamedHealth = parserHealth(renamedRecords, renamedObs);
  assert.equal(renamedHealth.ok, false, 'a missed shell call must NOT read as a clean scan');
  assert.equal(renamedHealth.chatOnly, false, 'and it is not a chat-only session either');
  assert.equal(renamedHealth.unread.length, 1);
  assert.match(renamedHealth.unread[0].why, /nested exec_command/);
});

// The control, and it is not optional: a health check that reports an error for
// every session is useless. A session that genuinely ran nothing is clean.
test('a genuinely chat-only session is clean, not an error', () => {
  const chat = [
    JSON.stringify({ timestamp: '2026-09-24T12:00:00.000Z', ordinal: 0, type: 'session_meta', payload: { id: 's', cwd: 'C:\\src\\example' } }),
    JSON.stringify({
      timestamp: '2026-09-24T12:00:01.000Z', ordinal: 1, type: 'response_item',
      payload: { type: 'message', id: 'm1', role: 'user', content: [{ type: 'input_text', text: 'Explain prefix rules.' }] },
    }),
    JSON.stringify({
      timestamp: '2026-09-24T12:00:02.000Z', ordinal: 2, type: 'response_item',
      payload: { type: 'reasoning', id: 'r1', summary: [], content: [{ type: 'reasoning_text', text: 'Thinking.' }] },
    }),
    JSON.stringify({
      timestamp: '2026-09-24T12:00:03.000Z', ordinal: 3, type: 'response_item',
      payload: { type: 'message', id: 'm2', role: 'assistant', content: [{ type: 'output_text', text: 'A prefix rule matches argv.' }] },
    }),
    // An orchestration call with no command argument. Present because the real
    // corpus has hundreds of them and a sloppier sniff would call them shell.
    JSON.stringify({
      timestamp: '2026-09-24T12:00:04.000Z', ordinal: 4, type: 'response_item',
      payload: { type: 'function_call', id: 'fc1', name: 'list_agents', arguments: '{}', call_id: 'call_y' },
    }),
    '',
  ].join('\n');
  const records = chat.split('\n').filter(Boolean).map((line) => JSON.parse(line));
  const observations = parseCodexJsonl(chat, { file: 'chat.jsonl', platform: 'win32' });
  assert.equal(observations.length, 0);
  const health = parserHealth(records, observations);
  assert.equal(health.chatOnly, true);
  assert.equal(health.ok, true, 'no shell calls means nothing was missed');
  assert.deepEqual(health.unread, []);
});

// THE SANITIZATION GATE. This runs on every suite, not at review time, because
// the mistake it prevents -- a real path, a machine name, an employer reference
// pushed to a public repository -- is not undoable by a later commit.
test('the fixture leaks nothing about the machine that inspired it', () => {
  const lower = TEXT.toLowerCase();
  const username = (os.userInfo().username || '').toLowerCase();
  const hostname = (os.hostname() || '').toLowerCase();

  if (username.length >= 3) {
    assert.equal(lower.includes(username), false, 'the fixture names the current user');
  }
  if (hostname.length >= 3) {
    assert.equal(lower.includes(hostname), false, 'the fixture names this machine');
  }
  // A home directory in any of its spellings.
  for (const marker of ['users\\\\', 'users/', '/home/', 'c:\\\\users', 'documents', 'onedrive']) {
    assert.equal(lower.includes(marker), false, `the fixture carries "${marker}"`);
  }
  // Anything recognisable from the real environment. Spelled as fragments so
  // this file does not become the thing it is policing.
  for (const marker of ['accent' + 'ure', 'permission-wildcarding', '.ai-work', 'desktoppet', 'ai-platform']) {
    assert.equal(lower.includes(marker.toLowerCase()), false, `the fixture carries "${marker}"`);
  }
  // Every absolute path in the fixture is under the synthetic root. Walked over
  // the DECODED values rather than the raw text: the exec input is a JSON string
  // inside a JSON string, so a raw scan sees `C:\\` and stops at the escape.
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
      // One level of escaping survives inside the exec input's embedded JSON,
      // so `C:\src` and `C:\\src` are the same path written twice over.
      assert.match(match[0].replace(/\\\\/g, '\\'), /^C:\\src(\\|$)/,
        `unexpected absolute path ${match[0]}`);
      paths += 1;
    }
  }
  assert.ok(paths >= 4, `WITNESS the path scan found ${paths} absolute paths to check`);
  // And the commands are generic tools, not anything learned here.
  const commands = parseCodexJsonl(TEXT, { file: FIXTURE, platform: 'win32' })
    .map((observation) => observation.command).sort();
  assert.deepEqual(commands, [
    'git status', 'node --help', 'node --version', 'rg --files', 'rg --nonexistent-flag',
  ]);
});
