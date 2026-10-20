'use strict';

// AGENT SESSIONS (src/agent-sessions.js): the sessions that wrote a transcript in the last fifteen
// minutes, read from the transcripts alone. Synthetic transcripts in a temp home: no real
// session, path or prompt.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { discoverSessions, sessionsSignature, WINDOW_MS } = require('../src/agent-sessions');

const jsonl = (...records) => `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
const NOW = Date.parse('2026-10-16T12:00:00Z');
const ago = (ms) => new Date(NOW - ms);

function home(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-sessions-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return { claudeRoot: path.join(root, 'projects'), codexRoot: path.join(root, 'sessions') };
}

function write(file, text, age) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  fs.utimesSync(file, ago(age), ago(age));
}

const claudeRecord = (fields) => ({ type: 'user', timestamp: '2026-10-16T11:59:00Z', message: { role: 'user', content: 'x' }, ...fields });

test('active Claude and Codex sessions are listed newest first, by folder name only', async (t) => {
  const roots = home(t);
  write(path.join(roots.claudeRoot, 'c--work-alpha', '11111111-aaaa-4aaa-8aaa-000000000001.jsonl'),
    jsonl(claudeRecord({ cwd: 'C:\\work\\alpha', entrypoint: 'claude-vscode', permissionMode: 'auto' })), 30 * 1000);
  write(path.join(roots.claudeRoot, 'c--work-beta', '22222222-bbbb-4bbb-8bbb-000000000002.jsonl'),
    jsonl(claudeRecord({ cwd: '/home/u/beta/', entrypoint: 'cli', permissionMode: 'default' })), 5 * 60 * 1000);
  // Older than the window: not listed.
  write(path.join(roots.claudeRoot, 'c--work-old', '33333333-cccc-4ccc-8ccc-000000000003.jsonl'),
    jsonl(claudeRecord({ cwd: 'C:\\work\\old', entrypoint: 'cli' })), WINDOW_MS + 60 * 1000);
  // Codex: the head names the app and folder, the latest turn_context the approval policy.
  write(path.join(roots.codexRoot, '2026', '10', '02', 'rollout-2026-10-02T07-17-29-44444444-dddd-4ddd-8ddd-000000000004.jsonl'),
    jsonl({ type: 'session_meta', payload: { id: '44444444-dddd-4ddd-8ddd-000000000004', cwd: 'D:\\repos\\gamma', originator: 'Codex Desktop' } },
      { type: 'turn_context', payload: { approval_policy: 'on-request' } },
      { type: 'turn_context', payload: { approval_policy: 'never' } }), 2 * 60 * 1000);
  // A compressed rollout is idle by definition and is never read.
  write(path.join(roots.codexRoot, '2026', '10', '01', 'rollout-2026-10-01T09-00-00-55555555-eeee-4eee-8eee-000000000005.jsonl.zst'),
    'not read', 1000);

  const sessions = await discoverSessions({ ...roots, now: NOW });
  assert.deepEqual(sessions.map((s) => [s.agent, s.id, s.app, s.project, s.mode]), [
    ['claude', '11111111', 'VS Code', 'alpha', 'auto'],
    ['codex', '44444444', 'Codex desktop', 'gamma', 'never'],
    ['claude', '22222222', 'CLI', 'beta', 'default'],
  ], 'witness:sessions-list -- the active sessions, their app, folder or mode were wrong');
  const text = JSON.stringify(sessions);
  for (const leak of ['work', 'home', 'repos', 'C:', 'D:']) assert.ok(!text.includes(leak), `a path reached the card: ${leak}`);
});

test('a subagent writing makes its parent session active, and is counted while it writes', async (t) => {
  const roots = home(t);
  const slug = path.join(roots.claudeRoot, 'c--work-alpha');
  const id = '66666666-ffff-4fff-8fff-000000000006';
  // The parent itself last wrote twenty minutes ago, outside the window.
  write(path.join(slug, `${id}.jsonl`), jsonl(claudeRecord({ cwd: 'C:\\work\\alpha', entrypoint: 'claude-vscode' })), 20 * 60 * 1000);
  write(path.join(slug, id, 'subagents', 'agent-a1.jsonl'), jsonl({ type: 'assistant' }), 20 * 1000);
  write(path.join(slug, id, 'subagents', 'agent-a2.jsonl'), jsonl({ type: 'assistant' }), 60 * 1000);
  write(path.join(slug, id, 'subagents', 'agent-a3.jsonl'), jsonl({ type: 'assistant' }), 10 * 60 * 1000);
  const [session] = await discoverSessions({ ...roots, now: NOW });
  assert.equal(session?.id, '66666666', 'witness:sessions-subagents -- a session whose subagents are working was not listed');
  assert.equal(session.subagents, 2, 'two wrote in the last two minutes; the third finished earlier');
  assert.equal(session.project, 'alpha');
  assert.equal(session.lastActiveAt, NOW - 20 * 1000);
});

test('an app no allowlist names is "other", and a missing field stays empty rather than guessed', async (t) => {
  const roots = home(t);
  write(path.join(roots.claudeRoot, 'p', '77777777-aaaa-4aaa-8aaa-000000000007.jsonl'),
    jsonl(claudeRecord({ cwd: 'C:\\x\\proj', entrypoint: 'some-future-host' })), 1000);
  const [session] = await discoverSessions({ ...roots, now: NOW });
  assert.equal(session.app, 'other');
  assert.equal(session.mode, null);
});

test('a mode found once is kept when a later read no longer reaches it', async (t) => {
  const roots = home(t);
  const file = path.join(roots.claudeRoot, 'p', '88888888-aaaa-4aaa-8aaa-000000000008.jsonl');
  write(file, jsonl(claudeRecord({ cwd: 'C:\\x\\proj', entrypoint: 'cli', permissionMode: 'plan' })), 1000);
  const cache = new Map();
  assert.equal((await discoverSessions({ ...roots, now: NOW, cache }))[0].mode, 'plan');
  // Over 4 MB of tool output with no prompt record after it: the read back stops short of the mode.
  const filler = jsonl(...Array.from({ length: 900 }, () => ({ type: 'assistant', cwd: 'C:\\x\\proj', entrypoint: 'cli', pad: 'p'.repeat(5000) })));
  fs.appendFileSync(file, filler);
  fs.utimesSync(file, ago(500), ago(500));
  assert.ok(fs.statSync(file).size > 4 * 1024 * 1024, 'precondition: the mode is beyond the read-back');
  assert.equal((await discoverSessions({ ...roots, now: NOW })).at(0).mode, null, 'control: a cold read cannot see it');
  assert.equal((await discoverSessions({ ...roots, now: NOW, cache })).at(0).mode, 'plan',
    'witness:sessions-mode-carry -- the mode vanished because the last 4 MB held no prompt');
});

test('the signature moves when a session changes or a minute passes, not on every write', () => {
  const base = [{ agent: 'claude', id: 'a', app: 'VS Code', project: 'p', mode: 'auto', subagents: 0, lastActiveAt: 120000 }];
  const same = sessionsSignature(base);
  assert.equal(sessionsSignature([{ ...base[0], lastActiveAt: 150000 }]), same, 'a write within the minute');
  assert.notEqual(sessionsSignature([{ ...base[0], lastActiveAt: 180000 }]), same, 'the next minute');
  assert.notEqual(sessionsSignature([{ ...base[0], subagents: 1 }]), same);
  assert.notEqual(sessionsSignature([]), same);
});

test('missing roots are an empty list, not an error', async () => {
  assert.deepEqual(await discoverSessions({ claudeRoot: path.join(os.tmpdir(), 'acolyte-none-1'),
    codexRoot: path.join(os.tmpdir(), 'acolyte-none-2'), now: NOW }), []);
});

// Codex 0.162/0.163 on Windows append without moving a rollout's mtime (measured 2026-10-20: four
// sessions writing that minute read the minute they started). The file is aged three hours by its
// mtime here, as those were, and its last record says one minute ago.
// MUTATION: take activity from the mtime again (drop meta.lastRecordMs in discoverSessions) and
// the session is not listed.
test('a Codex rollout whose mtime is stale is active by its last record time', async (t) => {
  const roots = home(t);
  const at = (ms) => new Date(NOW - ms).toISOString();
  write(path.join(roots.codexRoot, '2026', '10', '16', 'rollout-2026-10-16T09-00-00-77777777-aaaa-4aaa-8aaa-000000000007.jsonl'),
    jsonl({ type: 'session_meta', timestamp: at(3 * 3600 * 1000), payload: { id: '77777777-aaaa-4aaa-8aaa-000000000007', cwd: 'D:\\w\\delta', originator: 'codex_vscode', source: 'vscode' } },
      { type: 'turn_context', timestamp: at(2 * 60 * 1000), payload: { approval_policy: 'on-request' } },
      { type: 'response_item', timestamp: at(60 * 1000), payload: { type: 'message' } }), 3 * 3600 * 1000);
  // Control: stale by both, its last record an hour old.
  write(path.join(roots.codexRoot, '2026', '10', '16', 'rollout-2026-10-16T08-00-00-88888888-bbbb-4bbb-8bbb-000000000008.jsonl'),
    jsonl({ type: 'session_meta', timestamp: at(4 * 3600 * 1000), payload: { id: '88888888-bbbb-4bbb-8bbb-000000000008', cwd: 'D:\\w\\idle', originator: 'codex_vscode' } },
      { type: 'response_item', timestamp: at(3600 * 1000), payload: { type: 'message' } }), 4 * 3600 * 1000);
  const sessions = await discoverSessions({ ...roots, now: NOW });
  assert.deepEqual(sessions.map((s) => [s.id, s.project, s.mode]), [['77777777', 'delta', 'on-request']],
    'witness:sessions-codex-stale-mtime -- the session writing a minute ago was not listed, or the idle one was');
  assert.equal(sessions[0].lastActiveAt, NOW - 60 * 1000, 'its activity is its last record, not its mtime');
});

// MUTATION: list every rollout again (drop the `!row.meta.subagent` filter) and the guardian and
// the worker appear as sessions; stop counting workers and `subagents` reads 0.
test('a guardian review is not a session, and a spawned worker counts toward its session', async (t) => {
  const roots = home(t);
  const at = (ms) => new Date(NOW - ms).toISOString();
  const parentId = '99999999-cccc-4ccc-8ccc-000000000009';
  const rollout = (name, payload, age) => write(path.join(roots.codexRoot, '2026', '10', '16', `rollout-2026-10-16T10-00-00-${name}.jsonl`),
    jsonl({ type: 'session_meta', timestamp: at(3600 * 1000), payload: { cwd: 'D:\\w\\epsilon', originator: 'codex_vscode', ...payload } },
      { type: 'response_item', timestamp: at(age), payload: { type: 'message' } }), 3600 * 1000);
  rollout(parentId, { id: parentId, source: 'vscode' }, 90 * 1000);
  rollout('aaaaaaaa-dddd-4ddd-8ddd-00000000000a', { id: 'aaaaaaaa-dddd-4ddd-8ddd-00000000000a', source: { subagent: { thread_spawn: { parent_thread_id: parentId, depth: 1 } } } }, 30 * 1000);
  rollout('bbbbbbbb-eeee-4eee-8eee-00000000000b', { id: 'bbbbbbbb-eeee-4eee-8eee-00000000000b', source: { subagent: { other: 'guardian' } } }, 10 * 1000);
  // A worker whose session is idle is listed on its own rather than hidden.
  rollout('cccccccc-ffff-4fff-8fff-00000000000c', { id: 'cccccccc-ffff-4fff-8fff-00000000000c', source: { subagent: { thread_spawn: { parent_thread_id: 'dddddddd-0000-4000-8000-00000000000d' } } } }, 20 * 1000);
  const sessions = await discoverSessions({ ...roots, now: NOW });
  assert.deepEqual(sessions.map((s) => [s.id, s.subagents]), [['cccccccc', 0], ['99999999', 1]],
    'witness:sessions-codex-subagents -- the guardian was listed, the worker was not folded in, or the orphan was hidden');
  assert.equal(sessions[1].lastActiveAt, NOW - 30 * 1000, 'the worker\'s activity is its session\'s');
});
