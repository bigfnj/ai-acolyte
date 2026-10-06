'use strict';

// The PermissionRequest hook's decision, mode, log and report. Every test runs
// against a temporary home; `stopAt` keeps the project-settings walk inside it
// and `env: {}` keeps the agent host's own CLAUDE_CODE_ENTRYPOINT out of it.

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  runPermissionRequest, readHookMode, setHookMode, appendLog, summarizeLog, formatSummary,
} = require('../src/permission-request');

const CLI = path.resolve(__dirname, '../bin/wildcard-perms');
const ALLOW = '{"hookSpecificOutput":{"hookEventName":"PermissionRequest","decision":{"behavior":"allow"}}}';
const SECRET = 'SYNTHETIC-SECRET-0000';

function fixture(t, settings = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-permission-request-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.claude'), { recursive: true });
  if (settings !== null) fs.writeFileSync(path.join(home, '.claude', 'settings.json'), JSON.stringify(settings));
  const project = path.join(home, 'work', 'project');
  fs.mkdirSync(project, { recursive: true });
  return { home, project };
}

const options = (f, extra = {}) => ({ home: f.home, stopAt: f.home, managedSettingsFiles: [], env: {}, ...extra });

function event(f, command, extra = {}) {
  return { hook_event_name: 'PermissionRequest', tool_name: 'Bash', tool_input: { command },
    cwd: f.project, permission_mode: 'default', session_id: 's', transcript_path: null, ...extra };
}

const decideOn = (f, command, extra, opts) => runPermissionRequest('claude', event(f, command, extra), options(f, opts));

test('observe is the default: an allowed call is logged as would-approve and nothing is printed', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status *)', 'Bash(ls *)'] } });
  assert.equal(readHookMode(options(f)).mode, 'observe');
  const result = decideOn(f, 'git status && ls -la');
  assert.equal(result.output, null);
  assert.equal(result.entry.decision, 'would-approve');
  assert.equal(result.entry.reason, 'rules-allow');
  assert.equal(result.entry.segments, 2);
  assert.equal(result.entry.rules.length, 2);
});

test('approve mode prints exactly the allow decision, with no persistent grant or rewritten input', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status *)'] } });
  setHookMode('approve', options(f));
  const result = decideOn(f, 'git status');
  assert.equal(result.output, ALLOW);
  assert.deepEqual(JSON.parse(result.output), { hookSpecificOutput: { hookEventName: 'PermissionRequest',
    decision: { behavior: 'allow' } } });
  assert.equal(result.entry.decision, 'approved');
  setHookMode('observe', options(f));
  assert.equal(decideOn(f, 'git status').output, null);
});

test('a mode file that does not say exactly approve is observe', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status *)'] } });
  const file = path.join(f.home, '.ai-acolyte', 'permission-request-mode.json');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  for (const text of ['{broken', '{"mode":"APPROVE"}', '{"mode":"yes"}', '"approve"', '']) {
    fs.writeFileSync(file, text);
    assert.equal(readHookMode(options(f)).mode, 'observe', `mode file ${JSON.stringify(text)}`);
    assert.equal(decideOn(f, 'git status').output, null);
  }
  fs.writeFileSync(file, '\uFEFF{"mode":"approve"}');
  assert.equal(readHookMode(options(f)).mode, 'approve');
});

test('an ask rule outranks an allow rule, from user, managed and ancestor project settings', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git *)', 'Bash(curl *)', 'Bash(make *)'], ask: ['Bash(git push *)'] } });
  setHookMode('approve', options(f));
  let result = decideOn(f, 'git push origin main');
  assert.equal(result.entry.reason, 'ask-rule');
  assert.equal(result.output, null);
  fs.writeFileSync(path.join(f.home, '.claude', 'remote-settings.json'),
    JSON.stringify({ permissions: { ask: ['Bash(curl:*)'] } }));
  result = decideOn(f, 'curl -s https://example.test');
  assert.equal(result.entry.reason, 'ask-rule');
  assert.match(result.entry.rules[0], /^managed:ask:/);
  // An ask in the project ABOVE the shell's cwd still stops the hook.
  fs.mkdirSync(path.join(f.home, 'work', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'work', '.claude', 'settings.json'), JSON.stringify({ permissions: { ask: ['Bash(make *)'] } }));
  assert.equal(decideOn(f, 'make test').entry.reason, 'ask-rule');
  assert.equal(decideOn(f, 'git status').output, ALLOW);
});

test('an ancestor project allow rule is not used, while the cwd project allow rule is', (t) => {
  const f = fixture(t, {});
  setHookMode('approve', options(f));
  fs.mkdirSync(path.join(f.home, 'work', '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.home, 'work', '.claude', 'settings.json'), JSON.stringify({ permissions: { allow: ['Bash(git log *)'] } }));
  assert.equal(decideOn(f, 'git log --oneline').entry.reason, 'no-allow-rule');
  fs.mkdirSync(path.join(f.project, '.claude'), { recursive: true });
  fs.writeFileSync(path.join(f.project, '.claude', 'settings.local.json'), JSON.stringify({ permissions: { allow: ['Bash(git log *)'] } }));
  const result = decideOn(f, 'git log --oneline');
  assert.equal(result.output, ALLOW);
  assert.match(result.entry.rules[0], /^project-local:allow:/);
});

test('a deny rule outranks an allow rule on any segment', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(rm *)', 'Bash(ls *)'], deny: ['Bash(rm -rf /)'] } });
  setHookMode('approve', options(f));
  const result = decideOn(f, 'ls && rm -rf /');
  assert.equal(result.entry.reason, 'deny-rule');
  assert.equal(result.output, null);
});

test('deny and ask match across case and across the two shell tools', (t) => {
  const f = fixture(t, { permissions: { allow: ['PowerShell(remove-item *)', 'PowerShell(git push *)'],
    ask: ['PowerShell(Remove-Item *)', 'Bash(git push *)'] } });
  setHookMode('approve', options(f));
  assert.equal(decideOn(f, 'remove-item build', { tool_name: 'PowerShell' }).entry.reason, 'ask-rule');
  assert.equal(decideOn(f, 'git push', { tool_name: 'PowerShell' }).entry.reason, 'ask-rule');
});

test('every segment needs its own allow rule', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(ls *)'] } });
  setHookMode('approve', options(f));
  const result = decideOn(f, 'ls && curl https://example.test');
  assert.equal(result.entry.verdict, 'none');
  assert.equal(result.entry.reason, 'no-allow-rule');
  assert.equal(result.output, null);
});

test('shell structure and high-risk roots bar an approval even when every segment is allowed', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(echo *)', 'Bash(python *)', 'Bash(git *)', 'PowerShell(Remove-Item *)'] } });
  setHookMode('approve', options(f));
  const cases = [
    ['echo x > out.txt', 'Bash', 'write-redirection'],
    ['echo $(cat secret)', 'Bash', 'script-syntax'],
    ['python script.py', 'Bash', 'shell-wrapper'],
    ['Remove-Item -Recurse build', 'PowerShell', 'risk-destructive'],
  ];
  for (const [command, tool, code] of cases) {
    const result = decideOn(f, command, { tool_name: tool });
    assert.equal(result.entry.verdict, 'allow', command);
    assert.equal(result.entry.reason, 'structure', command);
    assert.ok(result.entry.structure.includes(code), `${command} -> ${result.entry.structure}`);
    assert.equal(result.output, null, command);
  }
  // An env prefix is not stripped before matching, so it never reaches allow.
  assert.equal(decideOn(f, 'GIT_DIR=x git status').output, null);
});

test('auto, plan, dontAsk and unknown permission modes abstain; default and acceptEdits may approve', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status *)'] } });
  setHookMode('approve', options(f));
  for (const mode of ['auto', 'plan', 'dontAsk', 'bypassPermissions', undefined]) {
    const result = decideOn(f, 'git status', { permission_mode: mode });
    assert.equal(result.entry.reason, 'permission-mode', String(mode));
    assert.equal(result.output, null, String(mode));
  }
  assert.equal(decideOn(f, 'git status', { permission_mode: 'acceptEdits' }).output, ALLOW);
});

test('a tool other than Bash or PowerShell is never approved, whatever the rules say', (t) => {
  const f = fixture(t, { permissions: { allow: ['Read', 'Edit', 'mcp__server__tool', 'WebFetch(domain:example.test)'] } });
  setHookMode('approve', options(f));
  for (const [tool, input] of [['Read', { file_path: '/x' }], ['Edit', { file_path: '/x' }],
    ['mcp__server__tool', {}], ['WebFetch', { url: 'https://example.test/' }]]) {
    const result = runPermissionRequest('claude', { ...event(f, ''), tool_name: tool, tool_input: input }, options(f));
    assert.equal(result.entry.reason, 'unsupported-tool', tool);
    assert.equal(result.output, null, tool);
  }
});

test('an unreadable settings source makes the hook abstain instead of evaluating a partial set', (t) => {
  const f = fixture(t, null);
  setHookMode('approve', options(f));
  const settings = path.join(f.home, '.claude', 'settings.json');
  fs.writeFileSync(settings, '{broken');
  assert.equal(decideOn(f, 'git status').entry.reason, 'rules-unreadable');
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(git status *)'], deny: 'Bash(rm *)' } }));
  assert.equal(decideOn(f, 'git status').entry.reason, 'rules-unreadable');
  fs.writeFileSync(settings, JSON.stringify({ permissions: { allow: ['Bash(git status *)'] } }));
  fs.mkdirSync(path.join(f.project, '.claude'));
  fs.writeFileSync(path.join(f.project, '.claude', 'settings.local.json'), '');
  const result = decideOn(f, 'git status');
  assert.equal(result.entry.reason, 'rules-unreadable');
  assert.deepEqual(result.entry.unreadable, ['project-local']);
  assert.equal(result.output, null);
});

test('a command the splitter and classifier disagree about is unparsed, not approved', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(ls *)'] } });
  setHookMode('approve', options(f));
  assert.equal(decideOn(f, 'FOO=1').entry.reason, 'unparsed');
  assert.equal(decideOn(f, '   ').entry.reason, 'unparsed');
});

test('a wrong event, a bad payload, an oversized one and an unknown product all abstain silently', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status *)'] } });
  setHookMode('approve', options(f));
  assert.equal(decideOn(f, 'git status', { hook_event_name: 'PreToolUse' }).entry.reason, 'wrong-event');
  for (const [input, opts] of [['{not json', {}], ['[]', {}], ['{}', { oversized: true }]]) {
    const result = runPermissionRequest('claude', input, options(f, opts));
    assert.equal(result.output, null);
    assert.equal(result.entry.reason, 'error');
  }
  assert.equal(runPermissionRequest('claude', '{}', options(f, { oversized: true })).entry.error, 'oversized-event');
  assert.equal(runPermissionRequest('other', event(f, 'git status'), options(f)).output, null);
});

test('the log line is metadata only: no command, path, description or transcript text', (t) => {
  const f = fixture(t, { permissions: { allow: [`Bash(echo ${SECRET} *)`, 'Bash(echo *)'] } });
  const transcript = path.join(f.home, 't.jsonl');
  fs.writeFileSync(transcript, `{"entrypoint":"claude-desktop","message":"${SECRET}"}\n`);
  const result = decideOn(f, `echo ${SECRET} C:\\Users\\someone\\x`, {
    transcript_path: transcript, tool_input: { command: `echo ${SECRET}`, description: `${SECRET} desc` },
    cwd: path.join(f.project), agent_id: 'a1', permission_suggestions: [`Bash(echo ${SECRET} *)`],
  });
  const text = JSON.stringify(result.entry);
  assert.equal(text.includes(SECRET), false, text);
  assert.equal(text.includes(f.home), false);
  assert.equal(text.includes('someone'), false);
  assert.equal(result.entry.host, 'claude-desktop');
  assert.equal(result.entry.subagent, true);
  const allowed = new Set(['v', 'ts', 'product', 'host', 'mode', 'permissionMode', 'tool', 'decision', 'reason',
    'verdict', 'segments', 'rules', 'structure', 'unwrapped', 'unreadable', 'subagent', 'error', 'ms']);
  for (const key of Object.keys(result.entry)) assert.ok(allowed.has(key), `unexpected log key ${key}`);
  for (const id of result.entry.rules) assert.match(id, /^[a-z-]+:(allow|ask|deny):[0-9a-f]{8}$/);
});

test('the host is the entrypoint variable first, then the newest transcript record', (t) => {
  const f = fixture(t, {});
  const transcript = path.join(f.home, 't.jsonl');
  fs.writeFileSync(transcript, '{"entrypoint":"claude-vscode"}\n{"entrypoint":"claude-desktop"}\n');
  assert.equal(decideOn(f, 'ls', { transcript_path: transcript }).entry.host, 'claude-desktop');
  assert.equal(decideOn(f, 'ls', { transcript_path: transcript }, { env: { CLAUDE_CODE_ENTRYPOINT: 'cli' } }).entry.host, 'cli');
  assert.equal(decideOn(f, 'ls', { transcript_path: transcript }, { env: { CLAUDE_CODE_ENTRYPOINT: 'a b/c\\d' } }).entry.host,
    'claude-desktop', 'a value that is not enum-shaped is ignored');
  assert.equal(decideOn(f, 'ls').entry.host, 'unknown');
});

// ── Codex ─────────────────────────────────────────────────────────────────────

function codexFixture(t, rules, bundle) {
  const f = fixture(t, {});
  const codexHome = path.join(f.home, '.codex');
  fs.mkdirSync(path.join(codexHome, 'rules'), { recursive: true });
  fs.writeFileSync(path.join(codexHome, 'rules', 'local.rules'), rules.map(([pattern, decision]) =>
    `prefix_rule(pattern = ${JSON.stringify(pattern)}, decision = ${JSON.stringify(decision)})`).join('\n') + '\n');
  if (bundle) fs.writeFileSync(path.join(codexHome, 'cloud-config-bundle-cache.json'), JSON.stringify(bundle));
  return { ...f, codexHome };
}

const codexEvent = (command, extra = {}) => ({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
  tool_input: { command }, permission_mode: 'default', session_id: 's', turn_id: 'u', cwd: '/', ...extra });
const decideCodex = (f, command, extra, opts) =>
  runPermissionRequest('codex', codexEvent(command, extra), { ...options(f), codexHome: f.codexHome, platform: 'linux', ...opts });

test('Codex: an allow prefix rule approves only in approve mode; a prompt rule outranks it', (t) => {
  const f = codexFixture(t, [[['git', 'status'], 'allow'], [['git'], 'allow'], [['git', 'push'], 'prompt']]);
  assert.equal(decideCodex(f, 'git status').entry.decision, 'would-approve');
  setHookMode('approve', options(f));
  assert.equal(decideCodex(f, 'git status').output, ALLOW);
  const push = decideCodex(f, 'git push origin');
  assert.equal(push.entry.reason, 'ask-rule');
  assert.equal(push.output, null);
  assert.equal(decideCodex(f, 'curl x').entry.reason, 'no-allow-rule');
});

test('Codex: a managed forbidden or prompt rule outranks a local allow rule', (t) => {
  const bundle = { signed_payload: { bundle: { requirements_toml: { enterprise_managed: [{ contents:
    '[[rules.prefix_rules]]\npattern = [{ token = "git" }, { token = "push" }]\ndecision = "forbidden"\n' }] } } } };
  const f = codexFixture(t, [[['git'], 'allow']], bundle);
  setHookMode('approve', options(f));
  const result = decideCodex(f, 'git push');
  assert.equal(result.entry.verdict, 'deny');
  assert.equal(result.output, null);
  assert.equal(decideCodex(f, 'git log').output, ALLOW);
});

test('Codex: a plain shell wrapper is unwrapped once; compounds, network approvals and other tools abstain', (t) => {
  const f = codexFixture(t, [[['git'], 'allow'], [['ls'], 'allow']]);
  setHookMode('approve', options(f));
  const wrapped = decideCodex(f, "bash -lc 'git status'");
  assert.equal(wrapped.output, ALLOW);
  assert.equal(wrapped.entry.unwrapped, true);
  assert.equal(decideCodex(f, 'git status && ls').entry.reason, 'structure');
  assert.equal(decideCodex(f, 'git fetch', { tool_input: { command: 'git fetch', description: 'needs network access' } })
    .entry.reason, 'network-approval');
  assert.equal(decideCodex(f, 'x', { tool_name: 'apply_patch' }).entry.reason, 'unsupported-tool');
  assert.equal(decideCodex(f, 'git status', { permission_mode: 'plan' }).entry.reason, 'permission-mode');
});

test('Codex: a rules file this reader cannot parse makes the hook abstain', (t) => {
  const f = codexFixture(t, [[['git'], 'allow']]);
  fs.writeFileSync(path.join(f.codexHome, 'rules', 'computed.rules'), 'for x in ["a"]:\n    prefix_rule(pattern=[x])\n');
  setHookMode('approve', options(f));
  const result = decideCodex(f, 'git status');
  assert.equal(result.entry.reason, 'rules-unreadable');
  assert.equal(result.output, null);
});

// ── log, report and the CLI entry ─────────────────────────────────────────────

test('the report groups by product and host and carries no command text', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status *)'] } });
  for (const [host, command] of [['claude-desktop', 'git status'], ['claude-desktop', `curl ${SECRET}`], ['cli', 'git status']]) {
    appendLog(decideOn(f, command, {}, { env: { CLAUDE_CODE_ENTRYPOINT: host } }).entry, options(f));
  }
  const summary = summarizeLog(options(f));
  assert.equal(summary.entries, 3);
  const desktop = summary.groups.find((group) => group.host === 'claude-desktop');
  assert.equal(desktop.total, 2);
  assert.deepEqual(desktop.decisions, { 'would-approve': 1, abstain: 1 });
  const text = formatSummary(summary);
  assert.match(text, /claude \/ claude-desktop: 2 prompt/);
  assert.equal(text.includes(SECRET), false);
  assert.equal(fs.readFileSync(summary.path, 'utf8').includes(SECRET), false);
});

test('the log rotates once past its cap instead of growing without bound', (t) => {
  const f = fixture(t, {});
  const log = path.join(f.home, '.ai-acolyte', 'permission-request.jsonl');
  fs.mkdirSync(path.dirname(log), { recursive: true });
  fs.writeFileSync(log, `${'x'.repeat(1024 * 1024 + 1)}\n`);
  appendLog({ v: 1 }, options(f));
  assert.equal(fs.readFileSync(log, 'utf8'), '{"v":1}\n');
  assert.ok(fs.existsSync(`${log}.1`));
});

function cli(f, args, input) {
  const env = { ...process.env, HOME: f.home, USERPROFILE: f.home, CODEX_HOME: path.join(f.home, '.codex') };
  delete env.CLAUDE_CODE_ENTRYPOINT;
  delete env.CODEX_INTERNAL_ORIGINATOR_OVERRIDE;
  return spawnSync(process.execPath, [CLI, ...args], { input, encoding: 'utf8', windowsHide: true, env, cwd: f.home });
}

test('CLI hook entry: silent in observe, the allow line in approve, one log line per call', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status *)'] } });
  // No cwd, so the project walk cannot leave the temporary home.
  const payload = JSON.stringify({ hook_event_name: 'PermissionRequest', tool_name: 'Bash',
    tool_input: { command: 'git status' }, permission_mode: 'default' });
  const observe = cli(f, ['--permission-request', 'claude'], payload);
  assert.equal(observe.status, 0, observe.stderr);
  assert.equal(observe.stdout, '');
  assert.equal(cli(f, ['--permission-hook', 'mode', 'approve']).status, 0);
  const approve = cli(f, ['--permission-request', 'claude'], payload);
  assert.equal(approve.status, 0, approve.stderr);
  assert.equal(approve.stdout, `${ALLOW}\n`);
  const lines = fs.readFileSync(path.join(f.home, '.ai-acolyte', 'permission-request.jsonl'), 'utf8').trim().split('\n');
  assert.deepEqual(lines.map((line) => JSON.parse(line).decision), ['would-approve', 'approved']);
  const report = cli(f, ['--permission-hook', 'report']);
  assert.equal(report.status, 0, report.stderr);
  assert.match(report.stdout, /claude \/ unknown: 2 prompt/);
});

test('CLI hook entry: a bad product exits 2 and never reaches PostToolUse hook mode', (t) => {
  const f = fixture(t, { permissions: { allow: ['Bash(git status)'] } });
  const settings = path.join(f.home, '.claude', 'settings.json');
  const before = fs.readFileSync(settings);
  for (const args of [['--permission-request'], ['--permission-request', 'other'], ['--permission-request', 'claude', 'x']]) {
    const run = cli(f, args, '{}');
    assert.equal(run.status, 2, args.join(' '));
    assert.equal(run.stdout, '');
  }
  // The wildcarding pass would have rewritten this allow list to Bash(git *).
  assert.ok(fs.readFileSync(settings).equals(before));
});
