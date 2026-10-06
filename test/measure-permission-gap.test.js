'use strict';

// The friction measurement reads real transcripts, so its one standing rule is
// that command text is read to evaluate a call and never printed. This drives it
// over a synthetic home whose commands carry an invented secret right after the
// root word, where any rendering of the command would show it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const SCRIPT = path.resolve(__dirname, '../scripts/measure-permission-gap.js');
const SECRET = 'SYNTHETIC-SECRET-1111';

function jsonl(file, records) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, records.map((record) => JSON.stringify(record)).join('\n') + '\n');
}

function syntheticHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-gap-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const cwd = path.join(home, 'work');
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(home, '.claude', 'settings.json'),
    JSON.stringify({ permissions: { allow: ['Bash(git status *)', 'Bash(git log *)'], ask: ['Bash(git push *)'] } }));
  const session = '0123abcd-0000-4000-8000-000000000001';
  const project = path.join(home, '.claude', 'projects', 'p');
  const base = { entrypoint: 'claude-desktop', cwd, sessionId: session };
  const use = (id, command, ts) => ({ ...base, type: 'assistant', timestamp: ts,
    message: { content: [{ type: 'tool_use', id, name: 'Bash', input: { command } }] } });
  const result = (id, ts, denial) => ({ ...base, type: 'user', timestamp: ts, ...(denial ? { toolDenialKind: denial } : {}),
    message: { content: [{ type: 'tool_result', tool_use_id: id, content: `out ${SECRET}` }] } });
  jsonl(path.join(project, `${session}.jsonl`), [
    { ...base, type: 'user', permissionMode: 'default', timestamp: '2026-10-06T10:00:00Z', message: { content: 'go' } },
    use('t1', `curl ${SECRET} https://example.test`, '2026-10-06T10:00:01Z'),
    result('t1', '2026-10-06T10:00:09Z', 'user-rejected'),
    use('t2', `git push ${SECRET}`, '2026-10-06T10:00:10Z'),
    result('t2', '2026-10-06T10:00:20Z'),
  ]);
  jsonl(path.join(project, session, 'subagents', 'agent-a.jsonl'), [
    use('t3', `git log ${SECRET}`, '2026-10-06T10:01:00Z'),
    result('t3', '2026-10-06T10:01:01Z'),
  ]);
  fs.mkdirSync(path.join(home, '.codex', 'rules'), { recursive: true });
  fs.writeFileSync(path.join(home, '.codex', 'rules', 'x.rules'), 'prefix_rule(pattern = ["git"], decision = "allow")\n');
  jsonl(path.join(home, '.codex', 'sessions', '2026', '10', '06', 'rollout-x.jsonl'), [
    { type: 'session_meta', payload: { originator: 'Codex Desktop' } },
    { type: 'turn_context', payload: { approval_policy: 'on-request' } },
    { type: 'response_item', payload: { type: 'custom_tool_call', name: 'exec', call_id: 'c1',
      input: `await tools.exec_command({ cmd: "git status ${SECRET}", sandbox_permissions: "require_escalated" })` } },
    { type: 'response_item', payload: { type: 'custom_tool_call_output', call_id: 'c1', output: `command rejected by user ${SECRET}` } },
  ]);
  return home;
}

function run(home, extra = []) {
  return spawnSync(process.execPath, [SCRIPT, '--home', home, ...extra], { encoding: 'utf8', windowsHide: true });
}

test('the gap measurement counts what it read and prints no command text', (t) => {
  const home = syntheticHome(t);
  const json = run(home, ['--json']);
  assert.equal(json.status, 0, json.stderr);
  const report = JSON.parse(json.stdout);
  const desktop = report.claude.hosts['claude-desktop'];
  // Non-vacuous: three calls were read, and each counter below has a cause.
  assert.equal(desktop.calls, 3);
  assert.equal(desktop.declinedDialogs, 1);
  assert.equal(desktop.askDialogsApproved, 1, 'the git push ran after an ask-rule dialog');
  assert.equal(desktop.visibleDialogs, 2);
  assert.equal(desktop.visibleDialogsApproved, 0);
  assert.equal(desktop.modeSources.inherited, 1, 'the subagent call inherits the session mode');
  assert.equal(desktop.wouldApprove, 1, 'git log in an inherited default-mode session');
  const codex = report.codex.hosts['Codex Desktop'];
  assert.equal(codex.escalationCalls, 1);
  assert.equal(codex.rejected, 1);
  const text = run(home);
  assert.equal(text.status, 0, text.stderr);
  for (const output of [json.stdout, text.stdout, json.stderr, text.stderr]) {
    assert.equal(output.includes(SECRET), false, 'a command, result or rule body reached the output');
    assert.equal(output.includes('example.test'), false);
  }
  assert.match(text.stdout, /claude-desktop: 3 calls/);
});
