'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { scanHistoryFiles } = require('../src/history-adapters');

test('MCP parser revision reopens unchanged cursors once and preserves policy while replacing false shell evidence', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-evidence-revision-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const transcript = path.join(sessions, 'mcp.jsonl');
  const events = [
    { type: 'response_item', payload: { type: 'function_call', namespace: 'mcp__Case.Server',
      name: 'exec_command', call_id: 'mcp-call', arguments: JSON.stringify({ cmd: 'git status' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'mcp-call', output: 'Process exited with code 0\nOutput:\nfixture' } },
    { type: 'event_msg', payload: { type: 'mcp_tool_call_end', call_id: 'mcp-call',
      invocation: { server: 'Case.Server', tool: 'exec_command', arguments: {} }, result: { Ok: { content: [], isError: false } } } },
  ];
  fs.writeFileSync(transcript, events.map(JSON.stringify).join('\n') + '\n');
  const scanned = scanHistoryFiles({ codexRoots: [sessions], platform: 'win32' });
  const options = { home, claudeRoots: [], codexRoots: [sessions], threshold: 1,
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }) };
  const previous = createAutoLearnManager({ ...options, historyScanner: () => ({ ...scanned, observations: [
    { id: 'misclassified-shell', source: 'codex', tool: 'PowerShell', command: 'git status', status: 'success' },
  ] }) });
  previous.scan(); previous.applyCodex();
  const state = JSON.parse(fs.readFileSync(previous.paths.state));
  state.codexEvidenceRevision = 1;
  fs.writeFileSync(previous.paths.state, JSON.stringify(state));
  const beforePolicy = fs.readFileSync(previous.paths.codexRules);
  const current = createAutoLearnManager(options);
  assert.equal(current.status().codexEvidence.pending, true, 'WITNESS revision 1 cursors cannot hide new MCP evidence');
  const result = current.scan({ platform: 'win32' });
  assert.equal(result.codexEvidence.pending, false);
  const rebuilt = JSON.parse(fs.readFileSync(previous.paths.state));
  assert.equal(rebuilt.codexEvidenceRevision, 3);
  assert.equal(rebuilt.candidates['powershell:git status'].counts.success, 0, 'WITNESS namespaced MCP no longer supplies shell successes');
  const mcp = rebuilt.candidates['codex-mcp:["Case.Server","exec_command"]'];
  assert.equal(mcp.kind, 'tool');
  assert.equal(mcp.counts.success, 1);
  assert.equal(mcp.claudePermission, null);
  assert.deepEqual(fs.readFileSync(previous.paths.codexRules), beforePolicy, 'migration does not silently revoke an old grant');
  assert.equal(current.scan({ platform: 'win32' }).newObservations, 0);
});

test('separate-wait parser revision reopens completed cursors once without rewriting grants or Claude evidence', t => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-wait-evidence-revision-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const records = [{ type: 'session_meta', payload: { id: 'wait-replay-session', cwd: home } }];
  for (const [index, command, exit] of [[0, 'git status', 0], [1, 'git log', 1]]) {
    records.push(
      { type: 'response_item', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'function_call', name: 'exec_command',
        call_id: `start-${index}`, arguments: JSON.stringify({ cmd: command }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: `start-${index}`,
        output: `Chunk ID: fixture\nWall time: 2 seconds\nProcess running with session ID ${8000 + index}\nOutput:\n` } },
      { type: 'response_item', payload: { type: 'function_call', name: 'write_stdin', call_id: `wait-${index}`,
        arguments: JSON.stringify({ session_id: 8000 + index, chars: '' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: `wait-${index}`,
        output: `Chunk ID: fixture\nWall time: 1 second\nProcess exited with code ${exit}\nOutput:\nfixture witness\n` } },
    );
  }
  fs.writeFileSync(path.join(sessions, 'wait.jsonl'), records.map(JSON.stringify).join('\n') + '\n');
  const scanned = scanHistoryFiles({ codexRoots: [sessions], platform: 'win32' });
  const options = { home, claudeRoots: [], codexRoots: [sessions], threshold: 1,
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }) };
  const previous = createAutoLearnManager({ ...options, historyScanner: () => ({ ...scanned, observations: [
    { id: 'kept-claude', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'success' },
    { id: 'old-codex', source: 'codex', tool: 'PowerShell', command: 'git status', status: 'success' },
  ] }) });
  previous.scan(); previous.applyCodex();
  const state = JSON.parse(fs.readFileSync(previous.paths.state));
  state.codexEvidenceRevision = 2;
  fs.writeFileSync(previous.paths.state, JSON.stringify(state));
  const policy = fs.readFileSync(previous.paths.codexRules), undo = state.lastApplication;
  const current = createAutoLearnManager(options);
  assert.equal(current.status().codexEvidence.pending, true, 'WITNESS revision 2 completed cursors must replay separate waits');
  const result = current.scan({ platform: 'win32' });
  assert.equal(result.codexEvidence.pending, false);
  const rebuilt = JSON.parse(fs.readFileSync(previous.paths.state));
  assert.equal(rebuilt.codexEvidenceRevision, 3);
  assert.equal(rebuilt.candidates['powershell:git status'].counts.success, 2, 'WITNESS exactly one terminal Codex success plus retained Claude success');
  assert.equal(rebuilt.candidates['powershell:git log'].counts.failed, 1, 'WITNESS terminal wait failure is replayed');
  assert.deepEqual(fs.readFileSync(previous.paths.codexRules), policy);
  assert.deepEqual(rebuilt.lastApplication, undo);
  assert.equal(current.scan({ platform: 'win32' }).newObservations, 0);
  assert.equal(current.undo().undone, true, 'the pre-replay Undo remains usable');
});

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-evidence-migration-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const stateFile = path.join(home, '.claude', 'wildcarding', 'auto-learn-state.json');
  const rulesFile = path.join(home, '.codex', 'rules', 'permission-wildcarding.rules');
  const settingsFile = path.join(home, '.claude', 'settings.json');
  const records = [];
  for (let index = 0; index < 3; index++) {
    records.push({ type: 'response_item', payload: {
      type: 'custom_tool_call', name: 'exec', call_id: `pending-${index}`,
      input: 'const result = await tools.exec_command({ cmd: "git status" }); text(result);',
    } });
    records.push({ type: 'response_item', payload: {
      type: 'custom_tool_call_output', call_id: `pending-${index}`, output: [
        { type: 'text', text: 'Script completed' },
        { type: 'text', text: JSON.stringify({ session_id: 700 + index, output: 'running' }) },
      ],
    } });
  }
  const transcript = path.join(sessions, 'rollout.jsonl');
  fs.writeFileSync(transcript, records.map((value) => JSON.stringify(value)).join('\n') + '\n');
  const current = scanHistoryFiles({ codexRoots: [sessions], platform: 'win32' });
  assert.equal(current.observations.length, 3);
  assert.ok(current.observations.every((entry) => entry.status === 'unknown'), 'fixture reproduces the corrected pending-process shape');
  const claudeCursor = 'path-sha256:111111111111111111111111';
  const legacyObservations = current.observations.map((entry) => ({ ...entry, status: 'success' }));
  legacyObservations.push(
    { id: 'claude-one', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'success' },
    { id: 'claude-two', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'success' },
    { id: 'claude-only', source: 'claude', tool: 'PowerShell', command: 'git log', status: 'success' },
  );
  const options = { home, codexValidator: () => ({ valid: true, decision: 'allow' }),
    codexHistoryStore: () => ({ stale: false, inspected: 'exact', reasons: [], notes: [] }) };
  const old = createAutoLearnManager({ ...options, historyScanner: () => ({ ...current,
    observations: legacyObservations,
    cursors: { ...current.cursors, [claudeCursor]: { source: 'claude', size: 90, offset: 90, mtimeMs: 1 } },
  }) });
  old.scan();
  old.apply();
  const read = () => JSON.parse(fs.readFileSync(stateFile, 'utf8'));
  const legacy = read();
  legacy.version = 1;
  for (const key of ['codexEvidenceRevision', 'codexEvidenceRebuildPending', 'legacyCodexEvidence', 'preservedEvidenceGrants']) delete legacy[key];
  for (const item of Object.values(legacy.candidates)) delete item.sourceCounts;
  legacy.mode = 'auto-safe';
  const writeLegacy = () => fs.writeFileSync(stateFile, JSON.stringify(legacy, null, 2) + '\n');
  writeLegacy();
  return { home, stateFile, rulesFile, settingsFile, legacy, read, writeLegacy, options, current, claudeCursor, transcript };
}

test('parser revision rebuilds Codex counts once while keeping Claude evidence and undo intact', (t) => {
  const f = fixture(t);
  const policy = [f.rulesFile, f.settingsFile].map((file) => fs.readFileSync(file, 'utf8'));
  const learn = createAutoLearnManager(f.options);
  assert.equal(learn.status().codexEvidence.pending, true, 'a status read already withholds stale evidence');
  assert.equal(learn.listCandidates().find((item) => item.key === 'powershell:git status').autoSafe, false);
  const first = learn.scan({ platform: 'win32' });
  const rebuilt = f.read();
  assert.equal(rebuilt.version, 3);
  assert.equal(first.codexEvidence.pending, false);
  assert.equal(first.application, null, 'migration itself never rewrites policy');
  assert.equal(rebuilt.candidates['powershell:git status'].counts.success, 2, 'WITNESS false Codex successes are removed, Claude successes remain');
  assert.equal(rebuilt.candidates['powershell:git log'].counts.success, 1);
  assert.deepEqual(rebuilt.cursors[f.claudeCursor], f.legacy.cursors[f.claudeCursor]);
  assert.deepEqual(rebuilt.applied, f.legacy.applied);
  assert.deepEqual(rebuilt.reviewed, f.legacy.reviewed);
  assert.deepEqual(rebuilt.lastApplication, f.legacy.lastApplication);
  assert.deepEqual([f.rulesFile, f.settingsFile].map((file) => fs.readFileSync(file, 'utf8')), policy);
  const second = learn.scan({ platform: 'win32' });
  assert.equal(second.newObservations, 0, 'rebuild cursor and hashes dedupe the next scan');
  assert.deepEqual(f.read().lastApplication, f.legacy.lastApplication, 'ordinary reconciliation must not revoke a preserved grant');
  assert.deepEqual([f.rulesFile, f.settingsFile].map((file) => fs.readFileSync(file, 'utf8')), policy);
  assert.equal(learn.undo().undone, true, 'the pre-upgrade undo still works');
});

test('partial mixed provenance is archived while only proven Claude counts remain eligible', (t) => {
  const f = fixture(t);
  const mixed = 'powershell:git status';
  const entries = Object.entries(f.legacy.observationHashes).filter(([, entry]) => entry.key === mixed);
  for (const source of ['claude', 'codex']) {
    const [id] = entries.find(([, entry]) => entry.source === source);
    delete f.legacy.observationHashes[id];
  }
  f.writeLegacy();
  const originalTransaction = JSON.stringify(f.legacy.lastApplication);
  const result = createAutoLearnManager(f.options).scan({ platform: 'win32' });
  const state = f.read();
  assert.equal(state.candidates[mixed].counts.success, 1, 'only the retained Claude hash proves a source');
  const archived = state.legacyCodexEvidence[mixed];
  assert.equal(archived.candidate.counts.success, 5, 'all original aggregate counts survive in the audit record');
  assert.deepEqual(archived.candidate.sources, ['claude', 'codex']);
  assert.equal(archived.retainedCounts.success, 1);
  assert.equal(archived.quarantinedCounts.success, 2, 'one lost Claude and one lost Codex hash cannot be guessed');
  assert.equal(result.codexEvidence.uncertainCandidates, 1);
  assert.equal(result.codexEvidence.quarantinedRuns, 2);
  assert.equal(JSON.stringify(state.lastApplication), originalTransaction);
  assert.deepEqual(state.applied, f.legacy.applied);
  assert.deepEqual(state.reviewed, f.legacy.reviewed);
  assert.deepEqual(state.codexTargets, f.legacy.codexTargets);
  assert.equal(createAutoLearnManager(f.options).status().lastScanStats.codexEvidence.quarantinedRuns, 2);
});

test('pure Codex evidence resets exactly even after its hashes were pruned', (t) => {
  const f = fixture(t);
  const mixed = f.legacy.candidates['powershell:git status'];
  mixed.sources = ['codex'];
  mixed.counts = { success: 3, failed: 0, unknown: 0, total: 3 };
  for (const [id, entry] of Object.entries(f.legacy.observationHashes)) {
    if (entry.key === mixed.key) delete f.legacy.observationHashes[id];
  }
  f.writeLegacy();
  const learn = createAutoLearnManager(f.options);
  assert.equal(learn.status().codexEvidence.pending, true);
  learn.scan({ platform: 'win32' });
  const rebuilt = f.read();
  assert.equal(rebuilt.candidates[mixed.key].counts.total, 0);
  assert.equal(rebuilt.legacyCodexEvidence[mixed.key].candidate.counts.success, 3);
  assert.equal(rebuilt.legacyCodexEvidence[mixed.key].quarantinedCounts.total, 0, 'a single source needs no guess about provenance');
  assert.equal(rebuilt.candidates['powershell:git log'].counts.success, 1);
  assert.deepEqual(rebuilt.lastApplication, f.legacy.lastApplication);
});

test('an incomplete Codex rebuild stays pending across reloads and never reapplies stale evidence', (t) => {
  const f = fixture(t);
  let calls = 0;
  const learn = createAutoLearnManager({ ...f.options, historyScanner: (options) => {
    calls++;
    assert.equal(Object.values(options.cursors).some((entry) => entry.source === 'codex'), false,
      'old Codex cursors are invalidated before the first rebuild read');
    return { observations: [], cursors: options.cursors,
      files: [{ source: 'codex', mode: 'error', scope: 'root', path: path.dirname(f.transcript), error: 'fixture unreadable' }] };
  } });
  assert.equal(learn.scan().codexEvidence.pending, true);
  const reopened = createAutoLearnManager(f.options);
  assert.equal(reopened.status().codexEvidence.pending, true);
  const item = reopened.listCandidates().find((value) => value.key === 'powershell:git status');
  assert.equal(item.autoSafe, false);
  assert.deepEqual(item.eligibleTargets, []);
  assert.throws(() => reopened.apply({ keys: [item.key], includeReviewed: true,
    expectedFingerprints: { [item.key]: item.fingerprint } }), /being rebuilt/);
  assert.deepEqual(f.read().lastApplication, f.legacy.lastApplication);
  assert.equal(calls, 1);
  assert.equal(reopened.scan({ platform: 'win32' }).codexEvidence.pending, false);
  assert.equal(f.read().candidates['powershell:git status'].counts.success, 2, 'retries do not subtract retained Claude counts twice');
});

test('an unfinished transcript cannot disappear behind another completed file', (t) => {
  const f = fixture(t);
  createAutoLearnManager({ ...f.options, historyScanner: () => ({ ...f.current,
    files: f.current.files.map((entry) => ({ ...entry, mode: 'partial' })),
  }) }).scan();
  fs.unlinkSync(f.transcript);
  const result = createAutoLearnManager({ ...f.options, historyScanner: () => ({
    observations: [], cursors: {}, files: [{ source: 'codex', mode: 'full', path: path.join(path.dirname(f.transcript), 'other.jsonl') }],
  }) }).scan();
  assert.equal(result.codexEvidence.pending, true, 'WITNESS a missing unfinished file cannot establish a complete rebuild');
  assert.equal(result.codexEvidence.remainingFiles, 1);
  assert.deepEqual(result.codexEvidence.reasons, ['unfinished-transcripts']);
  assert.equal(createAutoLearnManager(f.options).status().codexEvidence.remainingFiles, 1);
  assert.equal(f.read().candidates['powershell:git status'].counts.success, 2);
  assert.deepEqual(f.read().lastApplication, f.legacy.lastApplication);
});

test('new failed evidence revokes an automatic grant after its rebuild has finished', (t) => {
  const f = fixture(t);
  createAutoLearnManager(f.options).scan({ platform: 'win32' });
  const learn = createAutoLearnManager({ ...f.options, historyScanner: (options) => ({
    observations: [{ id: 'new-failure', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'failed' }],
    cursors: options.cursors, files: [{ source: 'claude', mode: 'full' }],
  }) });
  learn.scan();
  assert.equal(f.read().candidates['powershell:git status'].counts.failed, 1);
  assert.deepEqual(f.read().applied.claude, [], 'preservation cannot override later failed evidence');
  assert.deepEqual(f.read().applied.codex, []);
});

for (const source of ['claude', 'codex']) test(`new ${source} failure during a pending rebuild is not grandfathered`, (t) => {
  const f = fixture(t);
  const pending = createAutoLearnManager({ ...f.options, historyScanner: () => ({ ...f.current,
    observations: [{ id: `new-${source}-failure`, source, tool: 'PowerShell', command: 'git status', status: 'failed',
      timestamp: new Date(Date.now() + 60000).toISOString() }],
    files: f.current.files.map((entry) => ({ ...entry, mode: 'partial' })),
  }) });
  assert.equal(pending.scan().codexEvidence.pending, true);
  assert.equal(f.read().preservedEvidenceGrants['powershell:git status'].failureCountAtRebuild, 0,
    'WITNESS new failure is excluded from the historical preservation baseline');
  const resumed = createAutoLearnManager(f.options);
  assert.equal(resumed.scan({ platform: 'win32' }).codexEvidence.pending, false);
  resumed.scan({ platform: 'win32' });
  assert.deepEqual(f.read().applied.claude, []);
  assert.deepEqual(f.read().applied.codex, []);
});

test('undated Codex replay failures preserve old grants and disclose their uncertain timing', (t) => {
  const f = fixture(t);
  const pending = createAutoLearnManager({ ...f.options, historyScanner: () => ({ ...f.current,
    observations: [{ id: 'undated-failure', source: 'codex', tool: 'PowerShell', command: 'git status', status: 'failed' }],
    files: f.current.files.map((entry) => ({ ...entry, mode: 'partial' })),
  }) });
  const result = pending.scan();
  assert.equal(result.codexEvidence.untimedFailureRuns, 1);
  assert.ok(result.codexEvidence.reasons.includes('untimed-failures-preserved'));
  const resumed = createAutoLearnManager(f.options);
  resumed.scan({ platform: 'win32' });
  resumed.scan({ platform: 'win32' });
  assert.deepEqual(f.read().applied, f.legacy.applied);
  assert.equal(resumed.status().codexEvidence.untimedFailureRuns, 1);
  assert.equal(resumed.listCandidates().find((item) => item.key === 'powershell:git status').autoSafe, false);
});

test('preserved grants cannot supply old counts or definitions to a new Codex target', (t) => {
  const f = fixture(t);
  createAutoLearnManager(f.options).scan({ platform: 'win32' });
  const otherRules = path.join(f.home, 'other-workspace', '.codex', 'rules', 'acolyte.rules');
  const other = createAutoLearnManager({ ...f.options, codexRulesPath: otherRules });
  assert.equal(other.applyCodex().appliedCount, 0);
  assert.equal(fs.existsSync(otherRules), false, 'old target membership is not exported to another target');
  const more = createAutoLearnManager({ ...f.options, codexRulesPath: otherRules, historyScanner: (options) => ({
    observations: [{ id: 'fresh-success', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'success' }],
    cursors: options.cursors, files: [{ source: 'claude', mode: 'full' }],
  }) });
  more.scan();
  assert.match(fs.readFileSync(otherRules, 'utf8'), /3 successful/);
  assert.doesNotMatch(fs.readFileSync(otherRules, 'utf8'), /5 successful/, 'new target uses corrected evidence, not the preserved legacy snapshot');
});

test('a shell family correction rebuilds into its current key and records source totals', (t) => {
  const f = fixture(t);
  const corrected = [
    { type: 'response_item', payload: { type: 'function_call', name: 'exec_command', call_id: 'bash-now',
      arguments: JSON.stringify({ cmd: 'git status', shell: '/bin/bash' }) } },
    { type: 'response_item', payload: { type: 'function_call_output', call_id: 'bash-now',
      output: 'Process exited with code 0\nOutput:\nfixture' } },
  ];
  fs.writeFileSync(f.transcript, corrected.map((entry) => JSON.stringify(entry)).join('\n') + '\n');
  createAutoLearnManager(f.options).scan({ platform: 'win32' });
  const state = f.read();
  assert.equal(state.candidates['powershell:git status'].counts.success, 2);
  assert.equal(state.candidates['bash:git status'].counts.success, 1);
  assert.equal(state.candidates['powershell:git status'].sourceCounts.claude.success, 2);
  assert.equal(state.candidates['bash:git status'].sourceCounts.codex.success, 1);
  assert.equal(createAutoLearnManager(f.options).scan({ platform: 'win32' }).newObservations, 0);
});

test('preserving a migrated family does not freeze another applied family alternate spelling', (t) => {
  const f = fixture(t);
  createAutoLearnManager(f.options).scan({ platform: 'win32' });
  let observations = [1, 2, 3].map((index) => ({ id: `files-${index}`, source: 'claude',
    tool: 'PowerShell', command: 'git ls-files', status: 'success' }));
  const learn = createAutoLearnManager({ ...f.options, historyScanner: (options) => ({
    observations, cursors: options.cursors, files: [{ source: 'claude', mode: 'full' }],
  }) });
  learn.scan();
  observations = [{ id: 'files-exe', source: 'claude', tool: 'PowerShell', command: 'git.exe ls-files', status: 'success' }];
  learn.scan();
  assert.ok(JSON.parse(fs.readFileSync(f.settingsFile, 'utf8')).permissions.allow.includes('PowerShell(git.exe ls-files *)'),
    'WITNESS an unrelated existing grant can still add an observed spelling');
});
