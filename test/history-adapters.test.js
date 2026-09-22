'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  parseClaudeJsonl,
  parseCodexJsonl,
  extractNestedShellCommands,
  cursorKeyForFile,
  scanHistoryFiles,
} = require('../src/history-adapters');

function jsonl(...records) {
  return `${records.map((record) => JSON.stringify(record)).join('\n')}\n`;
}

function byCallId(observations, callId) {
  return observations.find((observation) => observation.callId === callId);
}

function responseItem(payload) {
  return { type: 'response_item', payload };
}

function codexCall(id, command) {
  return jsonl(
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: id,
      arguments: JSON.stringify({ command }),
    }),
    responseItem({ type: 'function_call_output', call_id: id, output: { exit_code: 0 } }),
  );
}

// `fs.symlinkSync(target, link, 'junction')` is unprivileged on Windows, where
// 'dir' and 'file' need SeCreateSymbolicLink or Developer Mode. Probe rather
// than assume, so a box without the privilege skips instead of failing.
const DIR_LINK = process.platform === 'win32' ? 'junction' : 'dir';
function canLink(type) {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-link-probe-'));
  try {
    const target = path.join(probe, 'target');
    if (type === 'file') fs.writeFileSync(target, '');
    else fs.mkdirSync(target);
    fs.symlinkSync(target, path.join(probe, 'link'), type);
    return true;
  } catch {
    return false;
  } finally {
    try { fs.rmSync(probe, { recursive: true, force: true }); } catch {}
  }
}
const CAN_LINK_DIR = canLink(DIR_LINK);
const CAN_LINK_FILE = canLink('file');

test('Claude parsing correlates tool results, failures, and out-of-order results', () => {
  const transcript = jsonl(
    { type: 'session_meta', payload: { id: 'claude-session' }, cwd: 'D:\\work' },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'result-first', content: 'done' }],
      },
    },
    {
      type: 'assistant',
      timestamp: '2026-08-15T01:00:00Z',
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'Checking.' },
          { type: 'tool_use', id: 'ok-call', name: 'Bash', input: { command: 'git status --short' } },
          { type: 'tool_use', id: 'failed-call', name: 'PowerShell', input: { command: 'Get-Item missing' } },
          { type: 'tool_use', id: 'unknown-call', name: 'Bash', input: { command: 'pwd' } },
          { type: 'tool_use', id: 'result-first', name: 'Bash', input: { command: 'rg TODO' } },
          { type: 'tool_use', id: 'ignored-call', name: 'Read', input: { file_path: 'README.md' } },
          { type: 'tool_use', id: 'unlearnable-call', name: 'TodoWrite', input: { todos: [] } },
        ],
      },
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'ok-call', is_error: false, content: 'clean' }],
      },
    },
    {
      type: 'user',
      toolUseResult: { exitCode: 7 },
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'failed-call', content: 'not found' }],
      },
    },
  );

  const observations = parseClaudeJsonl(transcript, {
    file: 'D:\\history\\claude.jsonl',
  });

  // File, web and MCP tools are learned too, so the shell calls are a subset.
  const shell = observations.filter((item) => item.kind !== 'tool');
  assert.equal(shell.length, 4);
  assert.deepEqual(shell.map(({ command }) => command), [
    'git status --short',
    'Get-Item missing',
    'pwd',
    'rg TODO',
  ]);
  assert.equal(byCallId(observations, 'ok-call').status, 'success');
  assert.equal(byCallId(observations, 'failed-call').status, 'failed');
  assert.equal(byCallId(observations, 'unknown-call').status, 'unknown');
  assert.equal(byCallId(observations, 'result-first').status, 'success');
  assert.equal(byCallId(observations, 'ok-call').session, 'claude-session');
  assert.equal(byCallId(observations, 'ok-call').cwd, 'D:\\work');

  // A file tool is recorded as a family with no path in it, and a tool with no
  // policy family of its own is still ignored.
  const tools = observations.filter((item) => item.kind === 'tool');
  assert.deepEqual(tools.map((item) => item.tool), ['Read']);
  assert.equal(tools[0].command, 'file');
  assert.doesNotMatch(JSON.stringify(observations), /README/);
});

test('Claude direct toolUseResult correlation honors structured failures', () => {
  const transcript = jsonl(
    {
      type: 'assistant',
      sessionId: 'direct-result-session',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: 'direct-fail', name: 'PowerShell',
          input: { command: 'Get-Content missing.txt' },
        }],
      },
    },
    {
      type: 'user',
      tool_use_id: 'direct-fail',
      toolUseResult: { success: false, exitCode: 1 },
      message: { role: 'user', content: [] },
    },
  );

  const [observation] = parseClaudeJsonl(transcript, { file: 'claude-direct.jsonl' });
  assert.equal(observation.status, 'failed');
});

test('Codex parsing correlates function calls and outputs without blessing unanswered calls', () => {
  const transcript = jsonl(
    { type: 'session_meta', payload: { id: 'codex-session', cwd: 'D:\\repo' } },
    responseItem({
      type: 'function_call_output', call_id: 'result-first',
      output: { exit_code: 0, output: 'found' },
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'ok-call',
      arguments: JSON.stringify({ command: 'git diff --stat', workdir: 'D:\\repo\\child' }),
    }),
    responseItem({
      type: 'function_call', name: 'functions.shell_command', call_id: 'failed-call',
      arguments: JSON.stringify({ command: 'rg missing .' }),
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'unknown-call',
      arguments: JSON.stringify({ command: 'git status' }),
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'result-first',
      arguments: JSON.stringify({ command: 'fd package.json' }),
    }),
    responseItem({
      type: 'function_call', name: 'read_file', call_id: 'ignored-call',
      arguments: JSON.stringify({ command: 'never observed' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'ok-call',
      output: 'Process exited with code 0\nFinal output:\n clean',
    }),
    responseItem({
      type: 'function_call_output', call_id: 'failed-call',
      output: { exitCode: 2, stderr: 'no matches' },
    }),
  );

  const observations = parseCodexJsonl(transcript, {
    file: 'D:\\history\\codex.jsonl',
    platform: 'win32',
  });

  assert.equal(observations.length, 4);
  assert.equal(byCallId(observations, 'ok-call').status, 'success');
  assert.equal(byCallId(observations, 'failed-call').status, 'failed');
  assert.equal(byCallId(observations, 'unknown-call').status, 'unknown');
  assert.equal(byCallId(observations, 'result-first').status, 'success');
  assert.equal(byCallId(observations, 'ok-call').cwd, 'D:\\repo\\child');
  assert.equal(byCallId(observations, 'ok-call').session, 'codex-session');
  assert.ok(observations.every(({ tool }) => tool === 'PowerShell'));
});

test('nested exec extraction accepts only literal tools.shell_command calls', () => {
  const source = [
    'const decoy = "tools.shell_command({ command: \\\"never\\\" })";',
    '// tools.shell_command({ command: "also never" });',
    'const first = await tools.shell_command({ workdir: "D:/repo", command: "git status --short" });',
    "const second = await tools.shell_command({ 'command': 'rg TODO src', timeout_ms: 1000 });",
    'const dynamic = await tools.shell_command({ command: suppliedCommand });',
    'const computed = await tools["shell_command"]({ command: "not accepted" });',
  ].join('\n');

  assert.deepEqual(extractNestedShellCommands(source), [
    'git status --short',
    'rg TODO src',
  ]);
});

test('Codex custom exec outcomes are conservatively attributed to nested calls', () => {
  const input = [
    'const a = await tools.shell_command({command: "git status"});',
    'const b = await tools.shell_command({command: "rg TODO"});',
  ].join('\n');
  const transcript = jsonl(
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-first', output: 'Exit code: 0' }),
    responseItem({ type: 'custom_tool_call', name: 'exec', call_id: 'exec-first', input }),
    responseItem({
      type: 'custom_tool_call', name: 'functions.exec', call_id: 'exec-failed',
      input: [
        'await tools.shell_command({ command: "npm test" });',
        'await tools.shell_command({ command: "node bad-script.js" });',
      ].join('\n'),
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'exec-failed',
      output: 'Script completed\nExit code: 1',
    }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-unknown',
      input: 'await tools.shell_command({ command: "node --version" })',
    }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-single',
      input: 'await tools.shell_command({ command: "pwd" })',
    }),
    responseItem({
      type: 'custom_tool_call_output',
      call_id: 'exec-single',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time: 1.2 seconds' },
        { type: 'input_text', text: 'Output:\nExit code: 0\nWall time: 1.1 seconds' },
      ],
    }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-conditional',
      input: 'if (false) await tools.shell_command({ command: \'git branch --show-current\' });',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-conditional', output: 'Exit code: 0' }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-caught',
      input: 'try { await tools.shell_command({ command: \'git rev-parse --is-inside-work-tree\' }); } catch {}',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-caught', output: 'Exit code: 0' }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-after-exit',
      input: 'exit(); await tools.shell_command({ command: \'rg --files\' });',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-after-exit', output: 'Exit code: 0' }),
  );

  const observations = parseCodexJsonl(transcript, {
    file: 'codex-exec.jsonl', platform: 'win32', session: 'codex-exec-session',
  });
  const grouped = Object.fromEntries(observations.map((item) => [item.command, item]));

  assert.deepEqual(Object.keys(grouped), [
    'git status', 'rg TODO', 'npm test', 'node bad-script.js', 'node --version', 'pwd',
    'git branch --show-current', 'git rev-parse --is-inside-work-tree', 'rg --files',
  ]);
  assert.equal(grouped['git status'].status, 'unknown');
  assert.equal(grouped['rg TODO'].status, 'unknown');
  assert.equal(grouped['npm test'].status, 'failed');
  assert.equal(grouped['node bad-script.js'].status, 'failed');
  assert.equal(grouped['node --version'].status, 'unknown');
  assert.equal(grouped.pwd.status, 'success');
  assert.equal(grouped['git branch --show-current'].status, 'unknown');
  assert.equal(grouped['git rev-parse --is-inside-work-tree'].status, 'unknown');
  assert.equal(grouped['rg --files'].status, 'unknown');
});

test('real observation IDs survive transcript moves and remain distinct per nested command', () => {
  const input = [
    'await tools.shell_command({ command: "git status" });',
    'await tools.shell_command({ command: "rg TODO" });',
  ].join('\n');
  const transcript = jsonl(responseItem({
    type: 'custom_tool_call', name: 'exec', call_id: 'stable-call', input,
  }));
  const first = parseCodexJsonl(transcript, {
    file: 'D:\\history\\stable.jsonl', session: 'stable-session', platform: 'win32',
  });
  const second = parseCodexJsonl(transcript, {
    file: 'E:\\copied-history\\renamed.jsonl', session: 'stable-session', platform: 'win32',
  });

  assert.deepEqual(first.map(({ id }) => id), second.map(({ id }) => id));
  assert.equal(new Set(first.map(({ id }) => id)).size, 2);
  assert.ok(first.every(({ id }) => /^codex:[a-f0-9]{24}$/.test(id)));

  const syntheticTranscript = jsonl(responseItem({
    type: 'function_call', name: 'shell_command', arguments: JSON.stringify({ command: 'pwd' }),
  }));
  const [syntheticA] = parseCodexJsonl(syntheticTranscript, {
    file: 'D:\\history\\synthetic.jsonl', session: 'stable-session', platform: 'win32',
  });
  const [syntheticB] = parseCodexJsonl(syntheticTranscript, {
    file: 'E:\\copied-history\\synthetic.jsonl', session: 'stable-session', platform: 'win32',
  });
  assert.notEqual(syntheticA.id, syntheticB.id);
});

test('incremental scanning replays overlap to correlate appended results with stable IDs', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const call = responseItem({
    type: 'function_call', name: 'shell_command', call_id: 'pending-call',
    arguments: JSON.stringify({ command: 'git status --short', workdir: root }),
  });
  fs.writeFileSync(file, jsonl(
    { type: 'session_meta', payload: { id: 'incremental-session', cwd: root } },
    call,
  ));

  const initial = scanHistoryFiles({ roots: { codex: root }, platform: 'win32', overlapBytes: 48 });
  assert.equal(initial.files[0].mode, 'full');
  assert.equal(initial.observations.length, 1);
  assert.equal(initial.observations[0].status, 'unknown');
  const initialId = initial.observations[0].id;

  const persistedCursors = JSON.parse(JSON.stringify(initial.cursors));
  const serializedCursors = JSON.stringify(persistedCursors);
  const [persistedKey] = Object.keys(persistedCursors);
  assert.equal(persistedKey, cursorKeyForFile(file));
  assert.match(persistedKey, /^path-sha256:[a-f0-9]{24}$/);
  assert.ok(!persistedKey.includes(path.basename(file)));
  assert.doesNotMatch(serializedCursors, /git status|command|arguments|call_id|pending-call/i);
  assert.deepEqual(
    Object.keys(Object.values(persistedCursors)[0]).sort(),
    ['headHash', 'headLength', 'ino', 'mtimeMs', 'offset', 'size', 'source', 'tailHash', 'tailLength', 'tailStart'].sort(),
  );

  fs.appendFileSync(file, jsonl(responseItem({
    type: 'function_call_output', call_id: 'pending-call', output: { exit_code: 0 },
  })));
  const appended = scanHistoryFiles({
    roots: { codex: root }, cursors: persistedCursors, platform: 'win32', overlapBytes: 48,
  });

  assert.equal(appended.files[0].mode, 'append');
  assert.equal(appended.observations.length, 1);
  assert.equal(appended.observations[0].id, initialId);
  assert.equal(appended.observations[0].status, 'success');

  // The append above appends a result whose CALL is outside the overlap, which
  // forces the reconciliation re-read -- and that re-read starts at byte 0, so
  // it puts the head-of-file `session_meta` back into the parse and masks what
  // an append really sees. A call that arrives WITH its own output needs no
  // reconciliation, so the slice is parsed alone; and Codex states `cwd` and
  // the session id in that head record only. Without them the manager drops
  // the observation outright when a workspace root is set, and when it is not,
  // the same call gets a SECOND identity, which defeats the observation-hash
  // dedupe and inflates the success counts that gate auto-safe apply.
  fs.appendFileSync(file, jsonl(
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'paired-call',
      arguments: JSON.stringify({ command: 'rg TODO src' }),
    }),
    responseItem({ type: 'function_call_output', call_id: 'paired-call', output: { exit_code: 0 } }),
  ));
  const paired = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(appended.cursors)),
    platform: 'win32', overlapBytes: 48,
  });
  assert.equal(paired.files[0].mode, 'append');
  assert.deepEqual(paired.observations.map(({ command }) => command), ['rg TODO src']);
  assert.equal(paired.observations[0].status, 'success');
  assert.equal(paired.observations[0].session, 'incremental-session',
    'an append slice starts past session_meta, so the session must be seeded from the head line');
  assert.equal(paired.observations[0].cwd, root,
    'without the seeded cwd the manager drops this observation as outside the workspace');
  const fromFull = scanHistoryFiles({ roots: { codex: root }, platform: 'win32' })
    .observations.find((item) => item.callId === 'paired-call');
  assert.equal(paired.observations[0].id, fromFull.id,
    'append and full must agree on the identity or the dedupe counts one call twice');

  // And the seed above must not have been bought by writing a path down. The
  // cursor gains no field, least of all a cwd.
  const pairedPersisted = JSON.parse(JSON.stringify(paired.cursors));
  assert.deepEqual(
    Object.keys(Object.values(pairedPersisted)[0]).sort(),
    Object.keys(Object.values(persistedCursors)[0]).sort(),
  );
  assert.ok(!JSON.stringify(pairedPersisted).includes(path.basename(root)),
    'a cwd is a user path, so recovering one must not persist one');

  const unchanged = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(paired.cursors)), platform: 'win32',
  });
  assert.equal(unchanged.files[0].mode, 'unchanged');
  assert.deepEqual(unchanged.observations, []);
  // An unchanged file reuses the fingerprint `safeContinuation` has just
  // verified rather than reading and re-hashing the same 8 KB to the same two
  // digests, so the cursor it writes must be byte-identical to the one it
  // carried in -- and must still verify on the scan after that.
  assert.deepEqual(JSON.parse(JSON.stringify(unchanged.cursors)), pairedPersisted);
  const twiceUnchanged = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(unchanged.cursors)), platform: 'win32',
  });
  assert.equal(twiceUnchanged.files[0].mode, 'unchanged');

  const legacyCursor = { [file]: Object.values(paired.cursors)[0] };
  const legacyUnchanged = scanHistoryFiles({ roots: { codex: root }, cursors: legacyCursor, platform: 'win32' });
  assert.equal(legacyUnchanged.files[0].mode, 'unchanged');
  assert.match(Object.keys(legacyUnchanged.cursors)[0], /^path-sha256:[a-f0-9]{24}$/);
});

test('incremental scanning falls back to a full scan after truncation', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-rewrite-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'claude.jsonl');
  fs.writeFileSync(file, jsonl({
    type: 'assistant', sessionId: 'old-session',
    message: { role: 'assistant', content: [{
      type: 'tool_use', id: 'old-call', name: 'Bash', input: { command: 'git status --short --branch' },
    }] },
  }));
  const initial = scanHistoryFiles({ roots: { claude: root } });

  fs.writeFileSync(file, jsonl({
    type: 'assistant', sessionId: 'new-session',
    message: { role: 'assistant', content: [{
      type: 'tool_use', id: 'new-call', name: 'Bash', input: { command: 'pwd' },
    }] },
  }));
  const rewritten = scanHistoryFiles({ roots: { claude: root }, cursors: initial.cursors });

  assert.equal(rewritten.files[0].mode, 'full');
  assert.deepEqual(rewritten.observations.map(({ command }) => command), ['pwd']);
});

// One unreadable file used to end the whole scan. The reads sat outside the
// per-file try, so the throw escaped scanHistoryFiles, escaped scan(), and took
// save(state) with it: every other file's cursor progress was discarded and the
// extension then backed its retry off to an hour. Nothing in the suite drove a
// failing read, so the entire catch had no coverage.
test('one unreadable transcript does not cost the whole scan its progress', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-scan-fail-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));

  const transcript = (id, command) => `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command', call_id: id, arguments: JSON.stringify({ command }) },
  })}\n${JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call_output', call_id: id, output: { exit_code: 0 } },
  })}\n`;

  // Sorted by path, so `b` is read between `a` and `c` and a throw there would
  // have taken `c` down with it as well as discarding `a`.
  for (const [name, command] of [['a', 'rg alpha'], ['b', 'rg beta'], ['c', 'rg gamma']]) {
    fs.writeFileSync(path.join(root, `${name}.jsonl`), transcript(`${name}-1`, command));
  }

  // Fail exactly one file's read, at the layer that really throws on a deleted
  // or locked transcript, rather than by mangling its contents: a parse failure
  // takes a different path and would not have reproduced this.
  const realOpen = fs.openSync;
  const target = path.join(root, 'b.jsonl');
  t.after(() => { fs.openSync = realOpen; });
  fs.openSync = (file, ...rest) => {
    if (String(file) === target) {
      const error = new Error(`EBUSY: resource busy or locked, open '${file}'`);
      error.code = 'EBUSY';
      throw error;
    }
    return realOpen(file, ...rest);
  };

  const result = scanHistoryFiles({ cursors: {}, codexRoots: [root], claudeRoots: [] });
  const byMode = (mode) => result.files.filter((entry) => entry.mode === mode).map(
    (entry) => path.basename(entry.path)).sort();

  assert.deepEqual(byMode('error'), ['b.jsonl'], 'the locked file is reported, not thrown');
  assert.deepEqual(byMode('full'), ['a.jsonl', 'c.jsonl'], 'and the others were still read');
  assert.equal(Object.keys(result.cursors).length, 2,
    'two cursors survive, so the next scan does not redo the whole corpus');
  assert.deepEqual(result.observations.map((item) => item.command).sort(),
    ['rg alpha', 'rg gamma']);
  assert.match(result.files.find((entry) => entry.mode === 'error').error, /EBUSY/);

  // And the file recovers on its own once the read succeeds again, with no
  // manual intervention and no cursor invented for it in the meantime.
  fs.openSync = realOpen;
  const second = scanHistoryFiles({ cursors: result.cursors, codexRoots: [root], claudeRoots: [] });
  assert.deepEqual(second.observations.map((item) => item.command), ['rg beta'],
    'only the previously failed file is re-read');
  assert.equal(Object.keys(second.cursors).length, 3);
});

test('a rewritten file that fails to read does not keep a cursor that no longer fits', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-scan-stale-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  const line = (id, command) => `${JSON.stringify({
    type: 'response_item',
    payload: { type: 'function_call', name: 'shell_command', call_id: id, arguments: JSON.stringify({ command }) },
  })}\n`;

  fs.writeFileSync(file, `${line('one', 'rg first')}${line('two', 'rg second')}`);
  const first = scanHistoryFiles({ cursors: {}, codexRoots: [root], claudeRoots: [] });
  const cursor = first.cursors[cursorKeyForFile(file)];
  assert.ok(cursor, 'a clean scan records a cursor');

  // Truncate to something shorter, which makes the prior cursor describe bytes
  // that no longer exist, then fail the read. Carrying that cursor forward made
  // the next scan resume from the wrong offset and silently skip real calls, so
  // re-reading is the correct outcome even though it costs I/O.
  fs.writeFileSync(file, line('three', 'rg third'));
  const realOpen = fs.openSync;
  t.after(() => { fs.openSync = realOpen; });
  fs.openSync = () => { const e = new Error('EBUSY'); e.code = 'EBUSY'; throw e; };
  const failed = scanHistoryFiles({ cursors: first.cursors, codexRoots: [root], claudeRoots: [] });
  fs.openSync = realOpen;

  assert.equal(failed.files[0].mode, 'error');
  assert.equal(failed.cursors[cursorKeyForFile(file)], undefined,
    'a cursor for bytes that are gone is worse than none');

  const recovered = scanHistoryFiles({ cursors: failed.cursors, codexRoots: [root], claudeRoots: [] });
  assert.deepEqual(recovered.observations.map((item) => item.command), ['rg third'],
    'the rewritten content is read in full rather than skipped');
});

// Codex says how a script went in words even when it reports no exit code, and
// an `unknown` outcome is dropped as not-evidence without even a stored hash.
// Measured on this machine's Codex corpus: 30 observations of 6,870 gain an
// attributable outcome, +28 of them failures, and no candidate changes
// disposition. Small, and in the conservative direction.
test('Codex wording resolves an outcome when no exit code is reported', () => {
  const transcript = jsonl(
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'worded-fail',
      arguments: JSON.stringify({ command: 'rg missing' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'worded-fail',
      output: 'Script failed\nWall time 1.1 seconds\nOutput:\n',
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'worded-ok',
      arguments: JSON.stringify({ command: 'rg present' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'worded-ok',
      output: 'Script completed\nWall time 0.9 seconds\nOutput:\n',
    }),
    // An explicit code still wins over the wording, in both spellings.
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'code-wins',
      arguments: JSON.stringify({ command: 'rg conflicted' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'code-wins',
      output: 'Script completed\nExit code: 3',
    }),
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'json-quoted',
      arguments: JSON.stringify({ command: 'rg quoted' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'json-quoted',
      output: '{"output":"x","metadata":{"exit_code":1}}',
    }),
    // And silence stays silence: no code and no wording is still not evidence.
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'still-quiet',
      arguments: JSON.stringify({ command: 'rg pending' }),
    }),
    responseItem({
      type: 'function_call_output', call_id: 'still-quiet', output: 'Wall time 0.4 seconds',
    }),
  );

  const observations = parseCodexJsonl(transcript, { file: 'codex.jsonl', platform: 'win32' });
  const status = (command) => observations.find((item) => item.command === command)?.status;
  assert.equal(status('rg missing'), 'failed', 'Script failed is negative evidence');
  assert.equal(status('rg present'), 'success');
  assert.equal(status('rg conflicted'), 'failed', 'the exit code outranks the wording');
  assert.equal(status('rg quoted'), 'failed',
    'the double-quoted spelling JSON.stringify produces used to match no pattern');
  assert.equal(status('rg pending'), 'unknown');
});

test('a nested exec reports one status per execution, not one per mention of it', () => {
  // A single execution emits BOTH a `Script completed` summary and an `Output:`
  // block carrying its exit code. Reading the wording per string pushed two
  // statuses for one command, and the attribution logic then refused the pair
  // as a count mismatch, which is correct behaviour on wrong input. So the
  // wording is a whole-payload fallback, used only when no code is present.
  const withBoth = jsonl(
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'one-command',
      input: 'await tools.shell_command({ command: "pwd" })',
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'one-command',
      output: [
        { type: 'input_text', text: 'Script completed\nWall time: 1.2 seconds' },
        { type: 'input_text', text: 'Output:\nExit code: 0\nWall time: 1.1 seconds' },
      ],
    }),
  );
  const both = parseCodexJsonl(withBoth, { file: 'codex.jsonl', platform: 'win32' });
  assert.equal(both.find((item) => item.command === 'pwd')?.status, 'success',
    'one execution, one status, still attributable');

  // Wording alone, and only wording, is what the fallback is for.
  const wordingOnly = jsonl(
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'worded-only',
      input: 'await tools.shell_command({ command: "whoami" })',
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'worded-only',
      output: [{ type: 'input_text', text: 'Script failed\nWall time: 0.3 seconds' }],
    }),
  );
  const worded = parseCodexJsonl(wordingOnly, { file: 'codex.jsonl', platform: 'win32' });
  assert.equal(worded.find((item) => item.command === 'whoami')?.status, 'failed');

  // Success is the case that genuinely needs the nested statuses. Per
  // applyCodexGroupResult, a custom exec is only credited with success when
  // exactly one nested status says so, whereas failure can arrive through the
  // group status alone. So a wording-only SUCCESS is discarded as `unknown`
  // unless the nested fallback supplies it, and a first version of this test
  // covered only the failure path, which let a mutation removing that fallback
  // pass untouched.
  const wordedSuccess = jsonl(
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'worded-success',
      input: 'await tools.shell_command({ command: "git ls-files" })',
    }),
    responseItem({
      type: 'custom_tool_call_output', call_id: 'worded-success',
      output: [{ type: 'input_text', text: 'Script completed\nWall time: 0.6 seconds' }],
    }),
  );
  const success = parseCodexJsonl(wordedSuccess, { file: 'codex.jsonl', platform: 'win32' });
  assert.equal(success.find((item) => item.command === 'git ls-files')?.status, 'success');
});

// `tools.exec_command({ cmd })` is what a Codex 0.153.4 rollout contains, and
// the extractor knew only `tools.shell_command({ command })`. Since the
// extractor is the only route from a `custom_tool_call` to an observation, a
// current transcript produced NOTHING in every mode -- and silently, because
// an empty command list is also what a script that ran no shell looks like.
// `src/auto-learn.js:8-11` has known both names all along, so the two modules
// simply disagreed.
test('nested exec extraction accepts the exec_command spelling too', () => {
  const source = [
    'const decoy = "tools.exec_command({ cmd: \\\"never\\\" })";',
    '// tools.exec_command({ cmd: "also never" });',
    'const first = await tools.exec_command({ cmd: "git status --short" });',
    "const second = await tools.exec_command({ 'cmd': 'rg TODO src', yield_time_ms: 1000 });",
    'const third = await tools.exec_command({ shell: "bash", command: "npm test" });',
    'const dynamic = await tools.exec_command({ cmd: suppliedCommand });',
    'const computed = await tools["exec_command"]({ cmd: "not accepted" });',
    'const misspelled = await tools.exec_commands({ cmd: "not accepted" });',
  ].join('\n');

  assert.deepEqual(extractNestedShellCommands(source), [
    'git status --short',
    'rg TODO src',
    'npm test',
  ], 'an extractor that knows only tools.shell_command({ command }) sees a 0.153 rollout as empty');
});

test('an exec_command call is creditable, so a Codex-only corpus can still reach auto-safe', () => {
  const transcript = jsonl(
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-cmd-ok',
      input: 'await tools.exec_command({ cmd: "git status --short" })',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-cmd-ok', output: 'Exit code: 0' }),
    responseItem({
      type: 'custom_tool_call', name: 'exec', call_id: 'exec-cmd-fail',
      input: 'await tools.exec_command({ cmd: "npm test" })',
    }),
    responseItem({ type: 'custom_tool_call_output', call_id: 'exec-cmd-fail', output: 'Exit code: 1' }),
  );

  const observations = parseCodexJsonl(transcript, { file: 'codex.jsonl', platform: 'win32' });
  const status = (command) => observations.find((item) => item.command === command)?.status;
  assert.deepEqual(observations.map(({ command }) => command), ['git status --short', 'npm test'],
    'a rollout that calls tools.exec_command yielded no observations at all');
  // Success is attributable only through `customExecCanAttributeSuccess`, which
  // matched the older name alone. Teaching the extractor and not that would
  // have surfaced every Codex call with its outcome permanently `unknown`, so
  // `counts.success` would stay at zero and nothing would ever apply.
  assert.equal(status('git status --short'), 'success',
    'an exec_command call whose script ran cleanly is creditable, or nothing ever applies');
  assert.equal(status('npm test'), 'failed');
});

test('an append past an oversized session_meta still recovers the session and cwd', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-seed-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  // A FIXED-SIZE head read cannot recover the seed. On the real rollout this
  // record is 22,095 bytes, because `payload.base_instructions.text` carries
  // the whole ~21 KB Codex system prompt, and a read that stops mid-record
  // leaves `parseJsonlRecords` with no parseable line at all -- which it skips
  // in silence, so the recovery would fail invisibly. FINGERPRINT_BYTES is
  // 4096, so the head read `safeContinuation` already did is no use either.
  // The padding is multi-byte on purpose, so a character count is not a byte
  // count anywhere in this file.
  fs.writeFileSync(file, jsonl({
    type: 'session_meta',
    payload: {
      id: 'oversized-session', cwd: root,
      base_instructions: { text: 'é'.repeat(40 * 1024) },
    },
  }) + codexCall('first-call', 'git status --short'));
  assert.ok(fs.statSync(file).size > 64 * 1024, 'the head record is past one chunked read');

  const initial = scanHistoryFiles({ roots: { codex: root }, platform: 'win32', overlapBytes: 48 });
  assert.equal(initial.files[0].mode, 'full');
  assert.equal(initial.observations[0].session, 'oversized-session');

  fs.appendFileSync(file, codexCall('second-call', 'rg TODO src'));
  const appended = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(initial.cursors)),
    platform: 'win32', overlapBytes: 48,
  });

  assert.equal(appended.files[0].mode, 'append');
  assert.deepEqual(appended.observations.map(({ command }) => command), ['rg TODO src']);
  assert.equal(appended.observations[0].session, 'oversized-session',
    'a fixed-size head read cannot reach a 22 KB session_meta, so the seed must read to the newline');
  assert.equal(appended.observations[0].cwd, root,
    'without the seeded cwd the manager drops this observation as outside the workspace');
  const fromFull = scanHistoryFiles({ roots: { codex: root }, platform: 'win32' })
    .observations.find((item) => item.callId === 'second-call');
  assert.equal(appended.observations[0].id, fromFull.id,
    'append and full must agree on the identity or the dedupe counts one call twice');
  const appendedPersisted = JSON.parse(JSON.stringify(appended.cursors));
  assert.ok(!JSON.stringify(appendedPersisted).includes(path.basename(root)),
    'the recovered cwd is not written down anywhere');

  // An unchanged file reuses the fingerprint `safeContinuation` has just
  // verified instead of reading and re-hashing the same two 4 KB ranges to the
  // same two digests. This file is large enough that the head and tail ranges
  // do NOT overlap, so the two digests differ and a reuse that mixed them up
  // would show here -- and the reused cursor still has to verify next scan.
  const unchanged = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(appended.cursors)), platform: 'win32',
  });
  assert.equal(unchanged.files[0].mode, 'unchanged');
  assert.notEqual(appendedPersisted[Object.keys(appendedPersisted)[0]].headHash,
    appendedPersisted[Object.keys(appendedPersisted)[0]].tailHash);
  assert.deepEqual(JSON.parse(JSON.stringify(unchanged.cursors)), appendedPersisted,
    'the reused fingerprint must be the one safeContinuation just verified, digest for digest');
  const twiceUnchanged = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(unchanged.cursors)), platform: 'win32',
  });
  assert.equal(twiceUnchanged.files[0].mode, 'unchanged');

  // A cursor written by an older or hand-edited build can name weaker ranges
  // than this version would choose. `safeContinuation` still accepts it --
  // the bytes it names really do hash as claimed -- but REUSING it would carry
  // the weaker fingerprint forward on every scan from here on, so the reuse is
  // guarded and this one gets rebuilt at full strength instead.
  const cursorKey = Object.keys(appendedPersisted)[0];
  const weak = { ...appendedPersisted[cursorKey], headLength: 100 };
  weak.headHash = crypto.createHash('sha256')
    .update(fs.readFileSync(file).subarray(0, 100)).digest('hex');
  const rebuilt = scanHistoryFiles({
    roots: { codex: root }, cursors: { [cursorKey]: weak }, platform: 'win32',
  });
  assert.equal(rebuilt.files[0].mode, 'unchanged');
  assert.equal(Object.values(rebuilt.cursors)[0].headLength, 4096,
    'a weaker legacy fingerprint must be rebuilt, not reused and carried forward for ever');
});

test('record offsets are byte offsets, so a multi-byte transcript appends exactly once', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-bytes-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const file = path.join(root, 'session.jsonl');
  // 3,000 two-byte characters, so a length measured in CHARACTERS is 3,000
  // short of the truth by the time the parser reaches the appended call. An
  // append keeps only the observations that end past the prior size, so
  // under-measured offsets drop the new call rather than reporting it.
  fs.writeFileSync(file, jsonl({
    type: 'session_meta',
    payload: { id: 'multibyte-session', cwd: root, notes: 'é'.repeat(3000) },
  }) + codexCall('old-call', 'git status --short'));
  const initial = scanHistoryFiles({ roots: { codex: root }, platform: 'win32' });
  assert.deepEqual(initial.observations.map(({ command }) => command), ['git status --short']);

  fs.appendFileSync(file, codexCall('new-call', 'rg TODO src'));
  // The default overlap reaches byte 0, so the whole file is re-parsed and
  // every offset in it has to be right for the filter to pick out just the
  // appended call.
  const appended = scanHistoryFiles({
    roots: { codex: root }, cursors: JSON.parse(JSON.stringify(initial.cursors)), platform: 'win32',
  });
  assert.equal(appended.files[0].mode, 'append');
  assert.deepEqual(appended.observations.map(({ command }) => command), ['rg TODO src'],
    'offsets measured in characters put the appended call before the prior size, so it is dropped');
});

// A Windows junction Dirent reports isDirectory() === false, isFile() === false
// and only isSymbolicLink() === true, so a walk that queues children on
// isDirectory() alone skipped the entire subtree -- with no error, so those
// transcripts did not exist as far as Auto Learn was concerned.
test('a junction or symlinked directory is walked, and a link cycle still terminates',
  { skip: !CAN_LINK_DIR }, (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-link-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'root');
    const outside = path.join(base, 'outside');
    fs.mkdirSync(path.join(root, 'inside'), { recursive: true });
    fs.mkdirSync(outside, { recursive: true });
    fs.writeFileSync(path.join(root, 'inside', 'a.jsonl'), codexCall('a', 'rg alpha'));
    fs.writeFileSync(path.join(outside, 'b.jsonl'), codexCall('b', 'rg beta'));
    fs.symlinkSync(outside, path.join(root, 'linked'), DIR_LINK);
    // Points back at the directory it lives in. Queuing links is what makes
    // this reachable at all, and the realpath set is what stops it -- which is
    // what that set was written for.
    fs.symlinkSync(root, path.join(root, 'loop'), DIR_LINK);

    const result = scanHistoryFiles({ roots: { codex: root }, platform: 'win32' });
    assert.deepEqual(result.observations.map(({ command }) => command).sort(),
      ['rg alpha', 'rg beta'],
      'a junction Dirent is neither a file nor a directory, so the subtree behind it was skipped');
    assert.deepEqual(result.files.filter((entry) => entry.mode === 'error'), []);
  });

test('a symlinked transcript is read rather than skipped for not being a regular file',
  { skip: !CAN_LINK_FILE }, (t) => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-filelink-'));
    t.after(() => fs.rmSync(base, { recursive: true, force: true }));
    const root = path.join(base, 'root');
    fs.mkdirSync(root, { recursive: true });
    const target = path.join(base, 'real.jsonl');
    fs.writeFileSync(target, codexCall('linked-call', 'rg gamma'));
    fs.symlinkSync(target, path.join(root, 'aliased.jsonl'), 'file');

    const result = scanHistoryFiles({ roots: { codex: root }, platform: 'win32' });
    assert.deepEqual(result.observations.map(({ command }) => command), ['rg gamma']);
  });

// `findJsonlFiles` swallows a readdir failure per directory, so an unreadable
// root came back as an empty corpus: no files, no observations, no errors --
// indistinguishable from "nothing to do", while the manager took that as
// licence to replace every cursor it held with nothing.
test('an unreadable root is reported as an error rather than as an empty corpus', (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'wildcard-history-root-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  fs.writeFileSync(path.join(root, 'session.jsonl'), codexCall('one', 'rg alpha'));

  const realReaddir = fs.readdirSync;
  t.after(() => { fs.readdirSync = realReaddir; });
  fs.readdirSync = (target, ...rest) => {
    if (String(target) === root) {
      const error = new Error(`EACCES: permission denied, scandir '${target}'`);
      error.code = 'EACCES';
      throw error;
    }
    return realReaddir(target, ...rest);
  };
  const blocked = scanHistoryFiles({ cursors: {}, codexRoots: [root], claudeRoots: [] });
  fs.readdirSync = realReaddir;

  assert.deepEqual(blocked.observations, []);
  assert.deepEqual(blocked.files.map((entry) => entry.mode), ['error'],
    'a root the walk could not read must not report as an empty corpus with no errors');
  assert.match(blocked.files[0].error, /EACCES/);
  assert.equal(blocked.files[0].path, path.resolve(root));

  // A root that is simply not there is NOT a failure. Every machine without
  // both agents has one, and reporting it would leave the error count nonzero
  // forever, which is the same lie in the other direction.
  const absent = scanHistoryFiles({
    cursors: {}, codexRoots: [path.join(root, 'no-such-directory')], claudeRoots: [],
  });
  assert.deepEqual(absent.files, []);
});

// The nested extractor learned both names for the shell entry point after a
// 0.153.x rollout produced zero observations from the whole Codex corpus. The
// non-nested reader was left knowing only `shell_command`, which is the same
// defect on the other path: a plain `function_call` carrying the command in its
// arguments yields nothing at all, and an empty observation list is
// indistinguishable here from a session that ran no shell.
//
// NOT VERIFIED AGAINST A REAL SAMPLE. No transcript on this machine carries
// this shape, so the fixture asserts only what the reader is being asked to
// accept: either name, either argument spelling, and nothing else assumed.
test('a non-nested exec_command function call is observed, under either argument spelling', () => {
  const transcript = jsonl(
    { type: 'session_meta', payload: { id: 'codex-session', cwd: 'D:\repo' } },
    responseItem({
      type: 'function_call', name: 'exec_command', call_id: 'cmd-call',
      arguments: JSON.stringify({ cmd: 'git status --short' }),
    }),
    responseItem({
      type: 'function_call', name: 'functions.exec_command', call_id: 'command-call',
      arguments: JSON.stringify({ command: 'rg TODO src' }),
    }),
    responseItem({ type: 'function_call_output', call_id: 'cmd-call', output: { exit_code: 0 } }),
    responseItem({ type: 'function_call_output', call_id: 'command-call', output: { exit_code: 1 } }),
  );

  const observations = parseCodexJsonl(transcript, { file: 'D:\history\codex.jsonl', platform: 'win32' });
  assert.equal(observations.length, 2);
  assert.equal(byCallId(observations, 'cmd-call').command, 'git status --short');
  assert.equal(byCallId(observations, 'cmd-call').status, 'success');
  assert.equal(byCallId(observations, 'command-call').command, 'rg TODO src');
  assert.equal(byCallId(observations, 'command-call').status, 'failed');
});

test('widening the name set does not widen what counts as a shell call', () => {
  // The control. `exec_command` is accepted by name, so the guard that matters
  // now is the one on the arguments: a call with neither spelling, and a call
  // by some other name, must still produce nothing.
  const transcript = jsonl(
    { type: 'session_meta', payload: { id: 'codex-session', cwd: 'D:\repo' } },
    responseItem({
      type: 'function_call', name: 'exec_command', call_id: 'no-command',
      arguments: JSON.stringify({ workdir: 'D:\repo' }),
    }),
    responseItem({
      type: 'function_call', name: 'exec_command', call_id: 'blank-command',
      arguments: JSON.stringify({ cmd: '   ' }),
    }),
    responseItem({
      type: 'function_call', name: 'apply_patch', call_id: 'other-tool',
      arguments: JSON.stringify({ cmd: 'git status' }),
    }),
  );
  assert.deepEqual(parseCodexJsonl(transcript, { platform: 'win32' }), []);
});

// Invariant 1 is asserted as "no observed FILE path leaves the parser", and a
// URL slipped past the shape of that assertion: `tool-learn.js` returned
// `input.url` verbatim as `observation.command`, so a path, a query string or a
// token in the URL sat on the observation right beside the rule it was supposed
// to be excluded by. Nothing downstream ever wanted more than the host.
test('a fetched URL reaches the parser as an origin, never as a path or a query', () => {
  const transcript = jsonl({
    type: 'assistant',
    sessionId: 'claude-session',
    cwd: 'D:\repo',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'fetch-1', name: 'WebFetch',
        input: { url: 'https://user:pw@Docs.Example.com:8443/uniquesecretpath?token=uniquetokenvalue#frag' },
      }],
    },
  });

  const [observation] = parseClaudeJsonl(transcript, { file: 'D:\history\claude.jsonl' });
  assert.equal(observation.command, 'https://docs.example.com',
    'scheme and host, and nothing else');
  const serialized = JSON.stringify(observation);
  for (const leak of ['uniquesecretpath', 'uniquetokenvalue', 'user:pw', '8443', 'frag']) {
    assert.ok(!serialized.includes(leak), `an observation must not carry "${leak}"`);
  }
});

test('a fetch target that is not an http origin produces no observation at all', () => {
  // Previously these still became observations carrying the raw string, and
  // were only discarded later by `toolInvocation`. Dropping them at the parser
  // is what makes "no URL leaves the parser" true rather than nearly true.
  const transcript = jsonl(...['file:///etc/uniquepasswdfile', 'not a url', 'https://localhost/x'].map((url, index) => ({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: `fetch-${index}`, name: 'WebFetch', input: { url } }],
    },
  })));
  assert.deepEqual(parseClaudeJsonl(transcript, { file: 'D:\history\claude.jsonl' }), []);
});

// ---------------------------------------------------------------------------
// Oversized transcripts. MEASURED 2026-09-22: a 2,266,973,030-byte Codex
// rollout cost 570-629 ms of every 755-849 ms scan and never finished, because
// the reconcile asked readRange for the whole file and readSync's int32 length
// wrapped to -2,027,994,266. These pin the three pieces of that fix.
// ---------------------------------------------------------------------------

function tempRoot(t, label) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `wildcard-history-${label}-`));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

// A Claude transcript of roughly `bytes`, every record a distinct shell call so
// observation loss is detectable rather than merely plausible.
function bulkClaude(file, calls, padding) {
  const records = [];
  for (let index = 0; index < calls; index += 1) {
    records.push({
      type: 'assistant',
      message: {
        role: 'assistant',
        content: [{
          type: 'tool_use', id: `call-${index}`, name: 'Bash',
          input: { command: `echo ${index} ${'p'.repeat(padding)}` },
        }],
      },
    });
    records.push({
      type: 'user',
      message: {
        role: 'user',
        content: [{ type: 'tool_result', tool_use_id: `call-${index}`, is_error: false, content: 'ok' }],
      },
    });
  }
  fs.writeFileSync(file, jsonl(...records));
}

test('READ_CHUNK_BYTES stays under the int32 ceiling readSync enforces', () => {
  const { READ_CHUNK_BYTES } = require('../src/history-adapters');
  assert.ok(Number.isFinite(READ_CHUNK_BYTES) && READ_CHUNK_BYTES > 0,
    'the chunk cap must be a real positive number');
  assert.ok(READ_CHUNK_BYTES <= 2147483647,
    'a chunk over 2^31-1 is the defect itself: readSync wraps the length '
    + 'negative and throws before reading a byte');
});

test('no single read asks for more than one chunk, however long the range', (t) => {
  const root = tempRoot(t, 'chunk');
  const file = path.join(root, 'bulk.jsonl');
  bulkClaude(file, 40, 400);
  const size = fs.statSync(file).size;
  assert.ok(size > 20000, `precondition: the fixture is worth chunking (${size} bytes)`);

  const lengths = [];
  const realReadSync = fs.readSync;
  t.after(() => { fs.readSync = realReadSync; });
  fs.readSync = (fd, buffer, offset, length, position) => {
    lengths.push(length);
    return realReadSync(fd, buffer, offset, length, position);
  };

  const result = scanHistoryFiles({ cursors: {}, claudeRoots: [root], readChunkBytes: 4096 });
  fs.readSync = realReadSync;

  assert.equal(result.files.length, 1, 'precondition: the fixture was scanned');
  assert.equal(result.files[0].mode, 'full');
  assert.ok(lengths.length > 0, 'precondition: reads were observed at all');
  const oversized = lengths.filter((length) => length > 4096);
  assert.deepEqual(oversized, [],
    'every readSync must be capped at the chunk size; an uncapped call is what '
    + 'wraps the int32 length on a file over 2 GiB');
  assert.ok(lengths.some((length) => length === 4096),
    'and the cap must actually bite, or this test is measuring a small file');
  assert.equal(result.observations.length, 40,
    'chunking must not lose a record: all 40 calls still parse');
});

test('a capped scan consumes a bounded slice, and the cursor records only that', (t) => {
  const root = tempRoot(t, 'cap');
  const file = path.join(root, 'bulk.jsonl');
  bulkClaude(file, 60, 300);
  const size = fs.statSync(file).size;

  const first = scanHistoryFiles({ cursors: {}, claudeRoots: [root], ingestBytes: 4096 });
  const entry = first.files[0];
  assert.equal(entry.mode, 'partial',
    'a scan that stopped short of EOF must say so, not report a clean full read');
  assert.ok(entry.consumedEnd < size,
    `precondition: the cap bit (${entry.consumedEnd} of ${size})`);

  const cursor = Object.values(first.cursors)[0];
  assert.equal(cursor.size, entry.consumedEnd,
    'the cursor records what was consumed; recording stat.size would silently '
    + 'skip everything between here and EOF');
  const bytes = fs.readFileSync(file);
  assert.equal(bytes[cursor.size - 1], 10,
    'and it lands on a newline, so the next scan resumes on a record boundary');
});

test('successive capped scans lose nothing against one uncapped scan', (t) => {
  const root = tempRoot(t, 'catchup');
  const file = path.join(root, 'bulk.jsonl');
  bulkClaude(file, 60, 300);

  const whole = scanHistoryFiles({ cursors: {}, claudeRoots: [root] });
  assert.equal(whole.files[0].mode, 'full', 'precondition: the uncapped scan read it all');

  const seen = new Set();
  let cursors = {};
  let ticks = 0;
  for (; ticks < 40; ticks += 1) {
    const pass = scanHistoryFiles({ cursors, claudeRoots: [root], ingestBytes: 4096 });
    for (const observation of pass.observations) seen.add(observation.id);
    cursors = JSON.parse(JSON.stringify(pass.cursors));
    if (pass.files[0].mode !== 'partial') break;
  }
  assert.ok(ticks > 1, `precondition: catch-up really took several ticks (${ticks + 1})`);
  assert.ok(ticks < 39, 'and it converged rather than running out of attempts');
  assert.deepEqual(
    [...seen].sort(),
    whole.observations.map((observation) => observation.id).sort(),
    'the union of the capped ticks must equal the single uncapped read, or the '
    + 'cap is losing evidence rather than spreading it',
  );
});

test('a read that throws still reports the bytes it had already taken', (t) => {
  const root = tempRoot(t, 'errbytes');
  const file = path.join(root, 'bulk.jsonl');
  bulkClaude(file, 40, 400);

  let calls = 0;
  const realOpenSync = fs.openSync;
  t.after(() => { fs.openSync = realOpenSync; });
  fs.openSync = (target, ...rest) => {
    if (String(target) === file) {
      calls += 1;
      if (calls > 1) throw Object.assign(new Error('EBUSY: simulated'), { code: 'EBUSY' });
    }
    return realOpenSync(target, ...rest);
  };

  const result = scanHistoryFiles({ cursors: {}, claudeRoots: [root], ingestBytes: 4096 });
  fs.openSync = realOpenSync;

  const entry = result.files[0];
  assert.equal(entry.mode, 'error', 'precondition: the second read really failed');
  assert.ok(entry.bytesRead > 0,
    'an error entry must carry what it read before throwing; reporting 0 is how '
    + 'a scan that pulled 118 MB off disk looked free for eight days');
});

test('a reconcile that cannot reach its call reports it instead of re-reading the file', (t) => {
  const root = tempRoot(t, 'reconcile');
  const file = path.join(root, 'rollout.jsonl');
  // The call, then enough filler that a bounded lookback cannot reach back to
  // it, then the matching result. This is the shape that used to trigger an
  // unbounded whole-file re-read.
  const filler = [];
  for (let index = 0; index < 200; index += 1) {
    filler.push(responseItem({ type: 'message', role: 'assistant', content: `${'f'.repeat(300)}` }));
  }
  fs.writeFileSync(file, jsonl(
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'far-call',
      arguments: JSON.stringify({ command: 'echo far' }),
    }),
    ...filler,
  ));

  const first = scanHistoryFiles({ roots: { codex: root }, platform: 'win32', overlapBytes: 48 });
  assert.equal(first.files[0].mode, 'full', 'precondition: the call was consumed first');
  const cursors = JSON.parse(JSON.stringify(first.cursors));
  const sizeAfterCall = fs.statSync(file).size;

  fs.appendFileSync(file, jsonl(
    responseItem({ type: 'function_call_output', call_id: 'far-call', output: { exit_code: 0 } }),
  ));

  const second = scanHistoryFiles({
    roots: { codex: root }, cursors, platform: 'win32',
    overlapBytes: 48, reconcileBytes: 64,
  });
  const entry = second.files[0];
  assert.equal(entry.unmatchedResults, 1,
    'a result whose call is beyond the lookback must be COUNTED, not dropped in '
    + 'silence; silence is how a missed failure looks like a clean family');
  assert.ok(entry.bytesRead < sizeAfterCall,
    `the bounded reconcile must not re-read the whole file (${entry.bytesRead} `
    + `bytes read against ${sizeAfterCall} before the append)`);
});

test('a same-size rewrite with a new mtime is still caught and re-read', (t) => {
  const root = tempRoot(t, 'rewrite');
  const file = path.join(root, 'bulk.jsonl');
  bulkClaude(file, 8, 40);
  const size = fs.statSync(file).size;

  const first = scanHistoryFiles({ cursors: {}, claudeRoots: [root] });
  const cursors = JSON.parse(JSON.stringify(first.cursors));
  const before = first.observations.map((observation) => observation.command).sort();

  // Rewrite in place at EXACTLY the same size, with different commands. This
  // is what the head/tail hashes exist to catch, and the mtime fast path must
  // not swallow it.
  const rewritten = fs.readFileSync(file, 'utf8')
    .replace(/echo (\d)/g, (whole, digit) => `ohce ${digit}`);
  assert.equal(Buffer.byteLength(rewritten), size,
    'precondition: the rewrite really is the same number of bytes');
  fs.writeFileSync(file, rewritten);
  const after = fs.statSync(file);
  assert.notEqual(after.mtimeMs, Object.values(cursors)[0].mtimeMs,
    'precondition: the rewrite moved the mtime, which is the ordinary case');

  const second = scanHistoryFiles({ cursors, claudeRoots: [root] });
  assert.equal(second.files[0].mode, 'full',
    'a same-size rewrite must force a full re-read, not read as unchanged');
  const commands = second.observations.map((observation) => observation.command).sort();
  assert.notDeepEqual(commands, before,
    'and the new content must actually be observed');
  assert.ok(commands.every((command) => command.startsWith('ohce')),
    'every observation comes from the rewritten file');
});

test('an untouched transcript is proved unchanged without reading its bytes', (t) => {
  const root = tempRoot(t, 'quiet');
  const file = path.join(root, 'bulk.jsonl');
  bulkClaude(file, 8, 40);

  const first = scanHistoryFiles({ cursors: {}, claudeRoots: [root] });
  const cursors = JSON.parse(JSON.stringify(first.cursors));

  let opens = 0;
  const realOpenSync = fs.openSync;
  t.after(() => { fs.openSync = realOpenSync; });
  fs.openSync = (target, ...rest) => {
    if (String(target) === file) opens += 1;
    return realOpenSync(target, ...rest);
  };
  const second = scanHistoryFiles({ cursors, claudeRoots: [root] });
  fs.openSync = realOpenSync;

  assert.equal(second.files[0].mode, 'unchanged', 'precondition: it read as unchanged');
  assert.equal(opens, 0,
    'an untouched file must cost a stat and nothing else; re-hashing two 4 KB '
    + 'ranges per transcript per tick was half the cost of a quiet scan');
});

test('a replaced file with the same size and mtime is caught by the inode', (t) => {
  const root = tempRoot(t, 'inode');
  const file = path.join(root, 'bulk.jsonl');
  bulkClaude(file, 8, 40);

  // Pin the timestamp to a whole millisecond BEFORE the first scan. utimesSync
  // cannot reproduce NTFS sub-millisecond precision, so a cursor recorded from
  // a natural write can never be matched exactly afterwards -- which is itself
  // why an ordinary restore trips the mtime leg without needing the inode.
  const pinned = new Date(Math.floor(Date.now() / 1000) * 1000);
  fs.utimesSync(file, pinned, pinned);

  const first = scanHistoryFiles({ cursors: {}, claudeRoots: [root] });
  const cursors = JSON.parse(JSON.stringify(first.cursors));
  const priorStat = fs.statSync(file);
  if (!priorStat.ino) {
    t.skip('this filesystem reports no inode, so the leg cannot be exercised here');
    return;
  }

  // A DIFFERENT file, same byte length, moved over the original and given the
  // original's timestamps. Size and mtime therefore agree with the cursor and
  // only the file id disagrees, which is the restore-shaped case.
  const replacement = path.join(root, 'replacement.jsonl');
  const rewritten = fs.readFileSync(file, 'utf8')
    .replace(/echo (\d)/g, (whole, digit) => `ohce ${digit}`);
  fs.writeFileSync(replacement, rewritten);
  fs.renameSync(replacement, file);
  fs.utimesSync(file, pinned, pinned);

  const after = fs.statSync(file);
  assert.equal(after.size, priorStat.size, 'precondition: same size');
  assert.equal(after.mtimeMs, priorStat.mtimeMs, 'precondition: same mtime');
  if (String(after.ino) === String(priorStat.ino)) {
    t.skip('this filesystem reused the file id, so the leg cannot be exercised here');
    return;
  }

  const second = scanHistoryFiles({ cursors, claudeRoots: [root] });
  assert.equal(second.files[0].mode, 'full',
    'a replaced file must not read as unchanged just because its size and '
    + 'timestamp were preserved; the file id is the only thing that differs');
});

test('a record larger than the cap still advances the cursor, and never rewinds it', (t) => {
  const root = tempRoot(t, 'bigrecord');
  const file = path.join(root, 'bulk.jsonl');
  // Small records first, then ONE record far larger than the ingest cap. The
  // capped window over that record holds no newline of its own, while the
  // overlap behind it is full of old ones. Taking the last newline anywhere in
  // the buffer therefore cut back to the cursor and the scan stalled forever.
  bulkClaude(file, 4, 20);
  const huge = {
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{
        type: 'tool_use', id: 'huge-call', name: 'Bash',
        input: { command: 'echo ' + 'H'.repeat(50000) },
      }],
    },
  };
  fs.appendFileSync(file, jsonl(huge));
  const size = fs.statSync(file).size;

  let cursors = {};
  const sizes = [];
  let ticks = 0;
  for (; ticks < 40; ticks += 1) {
    const pass = scanHistoryFiles({
      cursors, claudeRoots: [root], ingestBytes: 1000, overlapBytes: 500,
    });
    const cursor = Object.values(pass.cursors)[0];
    sizes.push(cursor ? cursor.size : -1);
    cursors = JSON.parse(JSON.stringify(pass.cursors));
    if (pass.files[0].mode !== 'partial') break;
  }

  assert.ok(ticks >= 2, `precondition: catch-up really took several ticks (${ticks + 1})`);
  assert.ok(ticks < 39,
    `the scan must finish; it stalled at ${JSON.stringify(sizes.slice(-4))} of ${size} bytes`);
  for (let i = 1; i < sizes.length; i += 1) {
    assert.ok(sizes[i] > sizes[i - 1],
      `every tick must advance the cursor, never stall or rewind: ${sizes[i - 1]} then ${sizes[i]}`);
  }
  assert.equal(sizes[sizes.length - 1], size, 'and it ends having accounted for the whole file');
});

test('a stretch with no record boundary at all is reported and stepped over', (t) => {
  const root = tempRoot(t, 'noboundary');
  const file = path.join(root, 'bulk.jsonl');
  // No newline anywhere in the first slice, and the hard maximum is set below
  // the file size so the widening cannot rescue it. Throwing here would write
  // no cursor and re-read the same bytes on every tick, forever.
  fs.writeFileSync(file, 'Z'.repeat(9000) + '\n' + jsonl({
    type: 'assistant',
    message: {
      role: 'assistant',
      content: [{ type: 'tool_use', id: 'after', name: 'Bash', input: { command: 'echo after' } }],
    },
  }));

  const first = scanHistoryFiles({
    cursors: {}, claudeRoots: [root], ingestBytes: 500, ingestHardMaxBytes: 2000,
  });
  const entry = first.files[0];
  assert.equal(entry.mode, 'unreadable',
    'a stretch with no boundary must be named, not thrown away or silently skipped');
  assert.ok(entry.unreadableBytes > 0, 'and it must say how much it stepped over');
  const cursor = Object.values(first.cursors)[0];
  assert.ok(cursor && cursor.size > 0,
    'a cursor must be written, or the same bytes are re-read on every tick forever');

  const second = scanHistoryFiles({
    cursors: JSON.parse(JSON.stringify(first.cursors)), claudeRoots: [root],
    ingestBytes: 500, ingestHardMaxBytes: 2000,
  });
  const secondCursor = Object.values(second.cursors)[0];
  assert.ok(secondCursor.size > cursor.size,
    'and the next scan resumes past it rather than repeating the same read');
});

test('a widened reconcile still seeds session and cwd from the file head', (t) => {
  const root = tempRoot(t, 'seedwiden');
  const file = path.join(root, 'rollout.jsonl');
  // session_meta at the top, then enough filler that a BOUNDED widen reaches
  // back past the call but NOT as far as the head. The unbounded re-read this
  // replaced always started at byte 0, so it got the head for free.
  const filler = [];
  for (let index = 0; index < 6; index += 1) {
    filler.push(responseItem({ type: 'message', role: 'assistant', content: 'f'.repeat(280) }));
  }
  fs.writeFileSync(file, jsonl(
    { type: 'session_meta', payload: { id: 'codex-session', cwd: 'D:\repo' } },
    ...filler,
    responseItem({
      type: 'function_call', name: 'shell_command', call_id: 'far-call',
      arguments: JSON.stringify({ command: 'echo far' }),
    }),
  ));
  const cursors = JSON.parse(JSON.stringify(
    scanHistoryFiles({ roots: { codex: root }, platform: 'win32', overlapBytes: 48 }).cursors));

  fs.appendFileSync(file, jsonl(
    responseItem({ type: 'function_call_output', call_id: 'far-call', output: { exit_code: 0 } }),
  ));

  const second = scanHistoryFiles({
    roots: { codex: root }, cursors, platform: 'win32',
    overlapBytes: 48, reconcileBytes: 400,
  });
  const found = byCallId(second.observations, 'far-call');
  assert.ok(found, 'precondition: the widened reconcile did reach the call');
  assert.equal(found.session, 'codex-session',
    'a widened reconcile begins mid-file, so it must be seeded; without the seed '
    + 'a configured workspace root drops this observation outright');
  assert.equal(found.cwd, 'D:\repo', 'and the cwd the workspace filter reads');
});

test('widening is clamped to the hard maximum, not merely stopped by it', (t) => {
  const root = tempRoot(t, 'clamp');
  const file = path.join(root, 'bulk.jsonl');
  // No newline in the first slice, so the widening loop runs. Quadrupling from
  // 1000 asks for 4000; the clamp holds it to 2000. Without the clamp the guard
  // only decides whether to widen AGAIN, so the allocation overshoots first.
  fs.writeFileSync(file, 'Z'.repeat(9000) + '\n');

  const result = scanHistoryFiles({
    cursors: {}, claudeRoots: [root], ingestBytes: 1000, ingestHardMaxBytes: 2000,
  });
  const entry = result.files[0];
  assert.ok(entry.bytesRead <= 3000,
    `the widened read must respect the hard maximum: read ${entry.bytesRead} bytes `
    + 'against a 1000-byte cap and a 2000-byte ceiling');
});
