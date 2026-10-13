'use strict';

// ARCHIVING A CODEX THREAD MUST NOT COUNT ITS CALLS TWICE.
//
// MEASURED 2026-10-13 on the development box: archiving a thread MOVES its
// rollout from `~/.codex/sessions/YYYY/MM/DD/` to a flat
// `~/.codex/archived_sessions/`. Cursor keys are a hash of the path, so the
// moved file has no cursor and is read again from byte 0, and the only thing
// standing between that re-read and a doubled `counts.success` -- the number
// that gates auto-safe apply -- is that every call comes back with the identity
// it was first counted under.
//
// For an ordinary rollout that holds by construction: a real call id makes the
// identity independent of the path. For a FORKED rollout it did not. Its head
// has two `session_meta` records (the fork, then its parent); the in-order parse
// ends on the parent, and the append-slice seed read only the first line and
// filed the slice under the fork. A call first counted in an append slice
// therefore returned under a second identity after the move. Three of the four
// archived rollouts on the box are forks.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { createAutoLearnManager } = require('../src/auto-learn-manager');

const THREAD = '0192aaaa-1111-7000-8000-00000000ab01';

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function call(home, id, command) {
  return jsonl(
    { type: 'response_item', payload: {
      type: 'function_call', name: 'shell_command', call_id: id,
      arguments: JSON.stringify({ command, workdir: home }),
    } },
    { type: 'response_item', payload: {
      type: 'function_call_output', call_id: id, output: JSON.stringify({ exit_code: 0, output: 'fixture' }),
    } },
  );
}

function fixture(t, label, head) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), `acolyte-archive-${label}-`));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const day = path.join(home, '.codex', 'sessions', '2026', '09', '24');
  fs.mkdirSync(day, { recursive: true });
  const name = `rollout-2026-09-24T10-00-00-${THREAD}.jsonl`;
  const live = path.join(day, name);
  fs.writeFileSync(live, jsonl(...head(home)) + call(home, 'call-1', 'git status --short'));
  const archive = path.join(home, '.codex', 'archived_sessions');
  const manager = () => createAutoLearnManager({
    home, claudeRoots: [path.join(home, '.claude', 'projects')], codexRulesPath: null,
    // The store probe answers about the real folders; this test is about the
    // evidence, so it stays out of the way.
    codexHistoryStore: () => ({ stale: false, inspected: 'exact', reasons: [], notes: [] }),
  });
  const success = () => Object.values(JSON.parse(fs.readFileSync(manager().paths.state, 'utf8')).candidates)
    .reduce((total, item) => total + item.counts.success, 0);
  const cursors = () => Object.keys(JSON.parse(fs.readFileSync(manager().paths.state, 'utf8')).cursors);
  const archiveIt = () => {
    fs.mkdirSync(archive, { recursive: true });
    fs.renameSync(live, path.join(archive, name));
  };
  return { home, live, manager, success, cursors, archiveIt };
}

test('archiving an ordinary Codex thread does not re-count its calls', (t) => {
  const f = fixture(t, 'plain', (home) => [{ type: 'session_meta', payload: { id: THREAD, cwd: home } }]);
  const first = f.manager().scan({ platform: 'win32' });
  assert.equal(first.newObservations, 1);
  fs.appendFileSync(f.live, call(f.home, 'call-2', 'git log --oneline'));
  // A small overlap so the append slice really starts past the head.
  assert.equal(f.manager().scan({ platform: 'win32', overlapBytes: 48 }).newObservations, 1);
  const before = f.success();

  f.archiveIt();
  const moved = f.manager().scan({ platform: 'win32' });
  assert.equal(moved.newObservations, 0, 'the archived transcript was counted again');
  assert.equal(f.success(), before);
  assert.equal(f.cursors().length, 1, 'one transcript, one cursor: the old path must not keep one');
});

test('archiving a FORKED Codex thread does not re-count a call first seen in an append slice', (t) => {
  const f = fixture(t, 'fork', (home) => [
    { type: 'session_meta', payload: { id: THREAD, forked_from_id: 'parent-thread', cwd: home } },
    { type: 'session_meta', payload: { id: 'parent-thread', cwd: home } },
  ]);
  assert.equal(f.manager().scan({ platform: 'win32' }).newObservations, 1);
  // The call this test is about: counted for the first time from an append
  // slice, which is where the head seed decides its session.
  fs.appendFileSync(f.live, call(f.home, 'call-2', 'git log --oneline'));
  assert.equal(f.manager().scan({ platform: 'win32', overlapBytes: 48 }).newObservations, 1);
  const before = f.success();
  assert.equal(before, 2, 'precondition: two calls, two successes');

  f.archiveIt();
  const moved = f.manager().scan({ platform: 'win32' });
  assert.equal(moved.newObservations, 0,
    'witness:fork-seed -- the move forced a full re-read and the appended call came back under a second identity');
  assert.equal(f.success(), before, 'counts.success, which gates auto-safe apply, was inflated by the move');
  assert.equal(f.cursors().length, 1);
});
