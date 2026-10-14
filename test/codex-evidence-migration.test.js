'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createAutoLearnManager } = require('../src/auto-learn-manager');
const { scanHistoryFiles } = require('../src/history-adapters');

// The current Codex evidence revision (src/auto-learn-manager.js,
// CODEX_EVIDENCE_REVISION). Pinned by value rather than imported, so a change that
// lowered it, or forgot it, fails here. 4 since 2026-10-13.
const CURRENT_REVISION = 4;

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
  assert.equal(rebuilt.codexEvidenceRevision, CURRENT_REVISION);
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
  assert.equal(rebuilt.codexEvidenceRevision, CURRENT_REVISION);
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
  // Survives a reload, from the LIVE status. `lastScanStats.codexEvidence`, a
  // saved copy only this line ever read, was dropped 2026-10-14.
  const reloaded = createAutoLearnManager(f.options).status();
  assert.equal(reloaded.codexEvidence.quarantinedRuns, 2);
  assert.equal(Object.hasOwn(reloaded.lastScanStats, 'codexEvidence'), false,
    'witness:evidence-snapshot -- the scan stats still carry a second copy of the rebuild status');
  assert.equal(Object.hasOwn(f.read().lastScanStats, 'codexEvidence'), false, 'and the state file does not hold one');
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

// WAS "an unfinished transcript cannot disappear behind another completed file",
// which held the rebuild open for ANY pending id a scan did not enumerate. The
// ids are path hashes and archiving MOVES a rollout to a new path (measured
// 2026-10-13), so a transcript archived mid-rebuild left an id nothing could
// ever read again: the rebuild stayed pending for good and auto-safe apply was
// blocked with no remedy. The moved file is enumerated under its new id and read
// from byte 0, so its evidence is rebuilt there. The half of the old witness
// that still holds is the control: a walk that could not list a root has not
// shown that anything is gone.
test('a pending transcript a clean walk no longer finds stops holding the rebuild open', (t) => {
  const f = fixture(t);
  createAutoLearnManager({ ...f.options, historyScanner: () => ({ ...f.current,
    files: f.current.files.map((entry) => ({ ...entry, mode: 'partial' })),
  }) }).scan();
  assert.equal(createAutoLearnManager(f.options).status().codexEvidence.remainingFiles, 1,
    'precondition: the capped read left the transcript pending');
  const archive = path.join(f.home, '.codex', 'archived_sessions');
  fs.mkdirSync(archive, { recursive: true });
  const moved = path.join(archive, path.basename(f.transcript));
  fs.renameSync(f.transcript, moved);
  const movedEntry = { source: 'codex', mode: 'full', path: moved };

  // The control first, while the id is still pending: one Codex root could not
  // be listed, so "not enumerated" is not evidence of anything.
  const blocked = createAutoLearnManager({ ...f.options, historyScanner: () => ({
    observations: [], cursors: {}, files: [movedEntry,
      { source: 'codex', mode: 'error', scope: 'root', path: path.dirname(f.transcript), error: 'fixture unreadable' }],
  }) }).scan();
  assert.equal(blocked.codexEvidence.pending, true, 'WITNESS a walk that could not look cannot establish a complete rebuild');
  assert.equal(blocked.codexEvidence.remainingFiles, 1,
    'witness:pending-leak -- a pending id was dropped by a walk that failed on a root');
  assert.deepEqual(blocked.codexEvidence.reasons, ['unfinished-transcripts']);

  const clean = createAutoLearnManager({ ...f.options, historyScanner: () => ({
    observations: [], cursors: {}, files: [movedEntry],
  }) }).scan();
  assert.equal(clean.codexEvidence.pending, false,
    'witness:pending-leak -- a path no walk can ever enumerate again held the rebuild open');
  assert.equal(clean.codexEvidence.remainingFiles, 0);
  assert.equal(createAutoLearnManager(f.options).status().codexEvidence.pending, false);
  assert.equal(f.read().codexEvidenceRebuildPending, false);
  assert.equal(f.read().candidates['powershell:git status'].counts.success, 2);
  // The clearing scan began as a rebuild, so it does not apply anything itself.
  assert.deepEqual(f.read().lastApplication, f.legacy.lastApplication);
});

// A CONFIGURED ROOT THAT IS MISSING IS A WALK THAT COULD NOT LOOK (2026-10-14).
// The drop above trusted any walk with no `scope: 'root'` failure, and
// `findJsonlFiles` skips a root that does not exist without a word, so a root
// that had vanished counted as a clean walk: its pending ids were dropped, the
// rebuild finished without its history, and auto-safe granted on what was left.
// The v1.6.2 audit reproduced it exactly as below -- success in root A,
// `git status` exit 1 in root B, root B absent for two scans -- and the code then
// wrote `PowerShell(git status *)` on scan 2 and revoked it on scan 3, when B came
// back and its failure was finally read.
function twoRoots(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-evidence-missing-root-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const rootA = path.join(home, 'history-a');
  const rootB = path.join(home, 'history-b');
  const write = (root, thread, callId, exit) => {
    fs.mkdirSync(root, { recursive: true });
    fs.writeFileSync(path.join(root, `rollout-${thread}.jsonl`), [
      { type: 'session_meta', payload: { id: thread, cwd: home } },
      { type: 'response_item', timestamp: '2026-01-01T00:00:00Z', payload: { type: 'function_call', name: 'exec_command',
        call_id: callId, arguments: JSON.stringify({ cmd: 'git status' }) } },
      { type: 'response_item', payload: { type: 'function_call_output', call_id: callId,
        output: `Process exited with code ${exit}\nOutput:\nfixture` } },
    ].map((record) => JSON.stringify(record)).join('\n') + '\n');
  };
  write(rootA, 'thread-a', 'call-a', 0);
  write(rootB, 'thread-b', 'call-b', 1);
  const options = { home, claudeRoots: [], codexRoots: [rootA, rootB], threshold: 1, mode: 'auto-safe',
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }) };
  const learn = () => createAutoLearnManager(options);
  learn().scan({ platform: 'win32' });
  const statePath = learn().paths.state;
  const settingsPath = learn().paths.claudeSettings;
  const read = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const state = read();
  assert.deepEqual(state.candidates['powershell:git status'].counts, { success: 1, failed: 1, unknown: 0, total: 2 },
    'precondition: one success in A, one failure in B');
  state.codexEvidenceRevision = CURRENT_REVISION - 1;
  fs.writeFileSync(statePath, JSON.stringify(state, null, 2) + '\n');
  const granted = () => fs.existsSync(settingsPath)
    && (JSON.parse(fs.readFileSync(settingsPath, 'utf8')).permissions?.allow || []).includes('PowerShell(git status *)');
  return { home, rootA, rootB, learn, read, granted };
}

test('a configured Codex root that is missing keeps the rebuild open, so auto-safe cannot grant past its failure', (t) => {
  const f = twoRoots(t);
  assert.equal(f.granted(), false, 'precondition: a family with a failure was never granted');
  const offline = `${f.rootB}-offline`;
  fs.renameSync(f.rootB, offline);

  const first = f.learn().scan({ platform: 'win32' });
  assert.equal(first.application, null, 'the rebuilding scan applies nothing');
  assert.equal(first.codexEvidence.pending, true,
    'witness:missing-root -- a root that is not there was read as a clean walk and the rebuild finished without it');
  assert.equal(first.codexEvidence.remainingFiles, 1, 'B\'s transcript is still owed a complete read');
  assert.equal(first.errors, 0, 'a missing root is not a read error: nothing failed, nothing was there to read');
  assert.equal(f.read().candidates['powershell:git status'].counts.success, 1, 'A was rebuilt meanwhile');

  f.learn().scan({ platform: 'win32' });
  assert.equal(f.granted(), false,
    'witness:missing-root -- auto-safe granted `PowerShell(git status *)` while the failure that forbids it sat in the missing root');

  // B comes back: its transcript is read from byte 0, the failure is counted, and
  // only now is the rebuild complete -- with nothing granted at any point.
  fs.renameSync(offline, f.rootB);
  const back = f.learn().scan({ platform: 'win32' });
  assert.equal(back.codexEvidence.pending, false);
  assert.equal(back.codexEvidence.remainingFiles, 0);
  assert.deepEqual(f.read().candidates['powershell:git status'].counts, { success: 1, failed: 1, unknown: 0, total: 2 });
  f.learn().scan({ platform: 'win32' });
  assert.equal(f.granted(), false, 'no grant, and so no revocation either');
});

// The reason a held rebuild leads its Codex reasons with (rebuildHeldOpenReason in the manager).
const HELD_OPEN = /^The Codex evidence rebuild is held open: the configured history folder/;

// The 9abc330 behaviour, through the REAL walk: a pending transcript archived
// mid-rebuild is enumerated under its new path, and its old id is dropped. And the
// one default root whose absence is benign: `archived_sessions/` on a box that
// never archived (Codex creates it on the first archive) does not hold a pending
// id open -- here, a pending transcript that was deleted.
test('control: a clean real walk still drops a moved or deleted transcript\'s pending id', (t) => {
  for (const [label, act] of [
    ['moved', (f) => {
      const archive = path.join(f.home, '.codex', 'archived_sessions');
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(f.transcript, path.join(archive, path.basename(f.transcript)));
    }],
    ['deleted, no archive folder ever', (f) => {
      assert.equal(fs.existsSync(path.join(f.home, '.codex', 'archived_sessions')), false,
        'precondition: the default archive root has never existed');
      fs.rmSync(f.transcript);
      // Another transcript, so the walk enumerates something: a Codex walk that
      // finds no file at all keeps the rebuild open as `history-unavailable`.
      fs.writeFileSync(path.join(path.dirname(f.transcript), 'other.jsonl'),
        JSON.stringify({ type: 'session_meta', payload: { id: 'other-thread', cwd: f.home } }) + '\n');
    }],
  ]) {
    const f = fixture(t);
    createAutoLearnManager({ ...f.options, historyScanner: () => ({ ...f.current,
      files: f.current.files.map((entry) => ({ ...entry, mode: 'partial' })),
    }) }).scan();
    assert.equal(createAutoLearnManager(f.options).status().codexEvidence.remainingFiles, 1,
      `${label}: precondition: the capped read left the transcript pending`);
    act(f);
    const clean = createAutoLearnManager(f.options).scan({ platform: 'win32' });
    assert.equal(clean.codexEvidence.pending, false, `${label}: a clean walk no longer holds a gone path pending`);
    assert.equal(clean.codexEvidence.remainingFiles, 0, label);
    // The benign absence holds nothing, so it names nothing.
    assert.ok(!(clean.codexHistoryReasons || []).some((reason) => HELD_OPEN.test(reason)),
      `${label}: a rebuild nothing holds was reported as held: ${JSON.stringify(clean.codexHistoryReasons)}`);
  }
});

// The exception to the benign absence: an `archived_sessions` that is a LINK to a
// folder that is not there right now -- a junction to an unplugged drive -- comes
// back with its files, so its absence is a walk that could not look.
test('an archive folder that is a link to a missing target still holds a pending transcript open', (t) => {
  const f = fixture(t);
  createAutoLearnManager({ ...f.options, historyScanner: () => ({ ...f.current,
    files: f.current.files.map((entry) => ({ ...entry, mode: 'partial' })),
  }) }).scan();
  const external = path.join(f.home, 'external-drive', 'archive');
  fs.mkdirSync(external, { recursive: true });
  const archive = path.join(f.home, '.codex', 'archived_sessions');
  fs.symlinkSync(external, archive, process.platform === 'win32' ? 'junction' : 'dir');
  fs.renameSync(f.transcript, path.join(archive, path.basename(f.transcript)));
  fs.writeFileSync(path.join(path.dirname(f.transcript), 'other.jsonl'),
    JSON.stringify({ type: 'session_meta', payload: { id: 'other-thread', cwd: f.home } }) + '\n');
  const unplugged = `${path.dirname(external)}-unplugged`;
  fs.renameSync(path.dirname(external), unplugged);

  // What the walk reports: the archive is missing, as a link, and it is not an error.
  const walked = scanHistoryFiles({ codexRoots: [path.join(f.home, '.codex', 'sessions'), archive], platform: 'win32' });
  assert.deepEqual(walked.missingRoots, [{ path: archive, source: 'codex', link: true }]);
  assert.equal(walked.files.filter((entry) => entry.mode === 'error').length, 0);

  const blocked = createAutoLearnManager(f.options).scan({ platform: 'win32' });
  assert.equal(blocked.codexEvidence.pending, true,
    'witness:missing-root-link -- an archive behind an unplugged junction was read as never having existed');
  assert.equal(blocked.errors, 0);
  // Named as a link, so the user looks for the drive rather than for a folder.
  assert.match(blocked.codexHistoryReasons[0] || '',
    /folder archived_sessions\/ \(a link to a missing target\) is missing, and 1 transcript\(s\)/);

  fs.renameSync(unplugged, path.dirname(external));
  const back = createAutoLearnManager(f.options).scan({ platform: 'win32' });
  assert.equal(back.codexEvidence.pending, false, 'the archived transcript is read under its new path and the old id is dropped');
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

// REVISION 4 (2026-10-13): one re-read of Codex history with that day's parser
// corrections. The transcript holds the record shapes Codex 0.161.0 was measured to
// write (scripts/check-codex-code-mode-runtime.js, scripts/check-codex-mcp-runtime.js),
// one per correction whose verdict a revision-3 state still carries:
//   a code-mode cell finished by `wait`, exit 0     revision 3: unknown  now: success
//   a cell whose nested command Codex refused       revision 3: failed   now: unknown
//   a declined MCP call (0.161.0 McpToolCall)       revision 3: failed   now: unknown
//   a direct exec_command that exited 1 (optional)  failed either way, dated history
// The revision-3 verdicts are what the previous manager is fed, the way the revision-2
// and revision-3 tests above feed theirs; the re-read uses the real scanner.
const REFUSED = 'approval policy is Never; reject command \u2014 you cannot ask for escalated permissions if the approval policy is Never';
function revisionFourTranscript({ directFailure = false } = {}) {
  const at = '2026-01-01T00:00:00Z';
  const item = (payload) => ({ timestamp: at, type: 'response_item', payload });
  const cell = (callId, command, extra = '') => item({ type: 'custom_tool_call', name: 'exec', call_id: callId,
    input: `// @exec: {"yield_time_ms": 500}\nconst result = await tools.exec_command({ cmd: "${command}", ${extra}yield_time_ms: 30000 });\ntext(result);\n` });
  return [
    { type: 'session_meta', payload: { id: 'revision-four-session', cwd: 'C:\\src\\example' } },
    cell('cell-joined', 'git status'),
    item({ type: 'custom_tool_call_output', call_id: 'cell-joined', output: 'Script running with cell ID 1\nWall time 1.0 seconds\nOutput:\n' }),
    item({ type: 'function_call', name: 'wait', call_id: 'wait-1', arguments: JSON.stringify({ cell_id: '1', yield_time_ms: 10000 }) }),
    item({ type: 'function_call_output', call_id: 'wait-1', output: [{ type: 'input_text', text: 'Script completed\nWall time 1.0 seconds\nOutput:\n' },
      { type: 'input_text', text: JSON.stringify({ chunk_id: 'c0ffee', wall_time_seconds: 1.0, exit_code: 0, original_token_count: 7, output: 'fixture\n' }) }] }),
    cell('cell-refused', 'git log', 'sandbox_permissions: "require_escalated", justification: "fixture", '),
    item({ type: 'custom_tool_call_output', call_id: 'cell-refused', output: [{ type: 'input_text', text: 'Script failed\nWall time 0.0 seconds\nOutput:\n' },
      { type: 'input_text', text: `Script error:\n${REFUSED}` }] }),
    { timestamp: at, type: 'event_msg', payload: { type: 'item_completed', thread_id: 'revision-four-session', turn_id: 'turn', item: {
      type: 'McpToolCall', id: 'mcp-declined', server: 'fixture', tool: 'succeed', arguments: {}, readOnlyHint: false,
      status: 'failed', error: { message: 'user rejected MCP tool call' }, duration: { secs: 0, nanos: 0 } } } },
    ...(directFailure ? [
      item({ type: 'function_call', name: 'exec_command', call_id: 'direct-failed', arguments: JSON.stringify({ cmd: 'git status' }) }),
      item({ type: 'function_call_output', call_id: 'direct-failed',
        output: 'Chunk ID: c0ffee\nWall time: 1.0 seconds\nProcess exited with code 1\nOriginal token count: 7\nOutput:\nfixture\n' }),
    ] : []),
  ];
}

// A revision-3 state as the previous release left it after its own complete re-read:
// the given verdicts, Claude evidence beside them, auto-safe grants applied, a Claude
// cursor, revision 3. `edit` adjusts the written state before it is reloaded.
function revisionThree(t, { directFailure = false, oldObservations, edit } = {}) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-evidence-revision-four-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const sessions = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  const transcript = path.join(sessions, 'rollout-revision-four.jsonl');
  fs.writeFileSync(transcript, revisionFourTranscript({ directFailure }).map((value) => JSON.stringify(value)).join('\n') + '\n');
  const scanned = scanHistoryFiles({ codexRoots: [sessions], platform: 'win32' });
  const claudeCursor = 'path-sha256:222222222222222222222222';
  const options = { home, claudeRoots: [], codexRoots: [sessions], threshold: 1,
    codexValidator: () => ({ valid: true, decision: 'allow' }),
    codexHistoryStore: () => ({ stale: false, inspected: 'unavailable', reasons: [], notes: [] }) };
  const claude = [
    { id: 'claude-status-1', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'success' },
    { id: 'claude-status-2', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'success' },
  ];
  // What revision 3's parser made of the transcript: the join, the refusal and the
  // MCP decline are its verdicts, not today's.
  const revisionThreeVerdicts = oldObservations || scanned.observations.map((entry) => ({ ...entry,
    status: entry.callId === 'cell-joined' ? 'unknown' : ['cell-refused', 'mcp-declined'].includes(entry.callId) ? 'failed' : entry.status }));
  const previous = createAutoLearnManager({ ...options, historyScanner: () => ({ ...scanned,
    observations: [...claude, ...revisionThreeVerdicts],
    cursors: { ...scanned.cursors, [claudeCursor]: { source: 'claude', size: 90, offset: 90, mtimeMs: 1 } } }) });
  previous.scan();
  previous.apply();
  const read = () => JSON.parse(fs.readFileSync(previous.paths.state, 'utf8'));
  const state = read();
  state.codexEvidenceRevision = 3;
  state.mode = 'auto-safe';
  if (edit) edit(state);
  fs.writeFileSync(previous.paths.state, JSON.stringify(state, null, 2) + '\n');
  return { options, paths: previous.paths, read, before: read(), claudeCursor, transcript };
}

test('revision 4 re-reads a revision-3 state\'s Codex history once and keeps Claude evidence, grants and Undo', (t) => {
  const f = revisionThree(t);
  const { before } = f;
  // Preconditions: the revision-3 verdicts are in the state, and a grant was made.
  assert.equal(before.candidates['powershell:git status'].counts.success, 2, 'precondition: Claude successes only');
  assert.equal(before.candidates['powershell:git log'].counts.failed, 1, 'precondition: the refusal counted as a failure');
  assert.equal(before.candidates['codex-mcp:["fixture","succeed"]'].counts.failed, 1, 'precondition: the decline counted as a failure');
  assert.ok(before.applied.claude.includes('powershell:git status') && before.lastApplication, 'precondition: an automatic grant and its Undo');
  assert.ok(Object.values(before.cursors).some((entry) => entry.source === 'codex'), 'precondition: a completed Codex cursor');
  const policy = [f.paths.codexRules, f.paths.claudeSettings].map((file) => fs.readFileSync(file, 'utf8'));

  const learn = createAutoLearnManager(f.options);
  assert.equal(learn.status().codexEvidence.pending, true, 'WITNESS a revision-3 state starts a rebuild on load');
  assert.equal(learn.status().codexEvidence.revision, CURRENT_REVISION);
  const first = learn.scan({ platform: 'win32' });
  assert.equal(first.codexEvidence.pending, false, 'the rebuild completes on a clean walk');
  assert.equal(first.application, null, 'the rebuilding scan applies nothing, auto-safe mode or not');
  const rebuilt = f.read();
  assert.equal(rebuilt.codexEvidenceRevision, CURRENT_REVISION);
  assert.equal(rebuilt.codexEvidenceRebuildPending, false);
  assert.deepEqual(rebuilt.codexEvidencePendingFiles, []);
  // The corrections, re-read: the joined cell's success arrives, the refusal and the
  // decline are no longer failures.
  assert.deepEqual(rebuilt.candidates['powershell:git status'].counts, { success: 3, failed: 0, unknown: 0, total: 3 });
  assert.deepEqual(rebuilt.candidates['powershell:git status'].sourceCounts.codex, { success: 1, failed: 0, unknown: 0, total: 1 });
  assert.equal(rebuilt.candidates['powershell:git log'].counts.failed, 0, 'WITNESS the refused cell is no longer a failure');
  assert.equal(rebuilt.candidates['codex-mcp:["fixture","succeed"]'].counts.failed, 0, 'WITNESS the declined MCP call is no longer a failure');
  // Nothing of Claude's, and no policy, moved.
  assert.deepEqual(rebuilt.candidates['powershell:git status'].sourceCounts.claude, before.candidates['powershell:git status'].sourceCounts.claude);
  assert.deepEqual(rebuilt.cursors[f.claudeCursor], before.cursors[f.claudeCursor]);
  for (const [id, entry] of Object.entries(before.observationHashes)) if (entry.source === 'claude') {
    assert.deepEqual(rebuilt.observationHashes[id], entry, 'a Claude observation hash survives');
  }
  assert.deepEqual(rebuilt.applied, before.applied);
  assert.deepEqual(rebuilt.reviewed, before.reviewed);
  assert.deepEqual(rebuilt.codexTargets, before.codexTargets);
  assert.deepEqual(rebuilt.lastApplication, before.lastApplication);
  assert.deepEqual([f.paths.codexRules, f.paths.claudeSettings].map((file) => fs.readFileSync(file, 'utf8')), policy);
  // Once: a second scan, and a fresh load, find nothing to rebuild or re-count.
  const second = learn.scan({ platform: 'win32' });
  assert.equal(second.newObservations, 0, 'the re-read is not repeated');
  assert.equal(second.codexEvidence.pending, false);
  assert.equal(f.read().codexEvidenceRebuildStartedAt, rebuilt.codexEvidenceRebuildStartedAt, 'no second rebuild began');
  assert.equal(createAutoLearnManager(f.options).status().codexEvidence.pending, false);
  assert.deepEqual(f.read().candidates['powershell:git status'].counts, rebuilt.candidates['powershell:git status'].counts);
  assert.equal(learn.undo().undone, true, 'the pre-rebuild Undo still works');
});

test('control: a revision-4 state does not rebuild, and its Codex cursors are handed to the scanner as they are', (t) => {
  const f = revisionThree(t, { edit: (state) => { state.codexEvidenceRevision = CURRENT_REVISION; } });
  const codexCursors = Object.entries(f.before.cursors).filter(([, entry]) => entry.source === 'codex');
  assert.ok(codexCursors.length, 'precondition: Codex cursors to keep');
  const learn = createAutoLearnManager({ ...f.options, historyScanner: (options) => {
    assert.deepEqual(Object.entries(options.cursors).filter(([, entry]) => entry.source === 'codex'), codexCursors,
      'WITNESS the Codex cursors were not invalidated');
    return { observations: [], cursors: options.cursors, files: [{ source: 'codex', mode: 'full', path: f.transcript }] };
  } });
  assert.equal(learn.status().codexEvidence.pending, false);
  learn.scan();
  const state = f.read();
  assert.equal(state.codexEvidenceRebuildPending, false);
  assert.equal(state.codexEvidenceRebuildStartedAt, f.before.codexEvidenceRebuildStartedAt);
  assert.deepEqual(state.candidates['powershell:git log'].counts, f.before.candidates['powershell:git log'].counts,
    'a current state keeps the verdicts it has; only a revision bump re-reads');
});

// A SECOND REBUILD MUST NOT COUNT A HISTORICAL FAILURE TWICE. A grant the revision-3
// rebuild preserved carries a baseline that already holds that rebuild's replayed
// Codex failure (here, a dated direct exec_command that exited 1). Revision 4 resets
// the Codex counts and replays the failure again; a baseline left as it was would
// hold it twice and absorb a genuinely new failure.
function preservedByRevisionThree(t, { newerUnreconciledFailure = false } = {}) {
  // The grant is made on the Claude successes alone (a family with a failure is not
  // auto-safe), and the edit below then records what the revision-3 replay found.
  return revisionThree(t, { directFailure: true, oldObservations: [], edit: (state) => {
    const key = 'powershell:git status';
    const item = state.candidates[key];
    // Revision 3's re-read had counted the historical Codex failure, and preserved
    // the grant across it: baseline = 0 Claude failures + 1 replayed.
    item.counts.failed += 1; item.counts.total += 1;
    item.sourceCounts.codex = { success: 0, failed: 1, unknown: 0, total: 1 };
    item.sources = ['claude', 'codex'];
    state.observationHashes['c'.repeat(64)] = { key, outcome: 'failed', source: 'codex' };
    if (newerUnreconciledFailure) {
      // And a Claude failure since, which no apply has reconciled yet.
      item.counts.failed += 1; item.counts.total += 1;
      item.sourceCounts.claude.failed += 1; item.sourceCounts.claude.total += 1;
    }
    state.preservedEvidenceGrants[key] = { ...item, failureCountAtRebuild: 1 };
    state.codexEvidenceUntimedFailureRuns = 1;
  } });
}

test('a grant revision 3 preserved keeps its protection once, and a new failure after revision 4 still revokes it', (t) => {
  const key = 'powershell:git status';
  // The control: no new failure, so the grant survives the rebuild and what follows.
  const kept = preservedByRevisionThree(t);
  const learn = createAutoLearnManager(kept.options);
  assert.equal(learn.scan({ platform: 'win32' }).codexEvidence.pending, false);
  const rebuilt = kept.read();
  assert.equal(rebuilt.candidates[key].counts.failed, 1, 'precondition: the historical Codex failure was replayed once');
  assert.equal(rebuilt.preservedEvidenceGrants[key].failureCountAtRebuild, 1,
    'WITNESS the baseline holds the replayed failure once, not twice');
  assert.equal(rebuilt.codexEvidenceUntimedFailureRuns, 0, 'the undated tally restarts with the rebuild that recounts it');
  learn.scan({ platform: 'win32' });
  assert.deepEqual(kept.read().applied, kept.before.applied, 'control: with no new failure the preserved grant stays');

  // A genuinely new failure after the rebuild: one more than the baseline revokes.
  const fresh = preservedByRevisionThree(t);
  createAutoLearnManager(fresh.options).scan({ platform: 'win32' });
  createAutoLearnManager({ ...fresh.options, historyScanner: (options) => ({
    observations: [{ id: 'new-claude-failure', source: 'claude', tool: 'PowerShell', command: 'git status', status: 'failed',
      timestamp: new Date(Date.now() + 60000).toISOString() }],
    cursors: options.cursors, files: [{ source: 'claude', mode: 'full' }] }) }).scan();
  assert.equal(fresh.read().candidates[key].counts.failed, 2);
  assert.equal(fresh.read().applied.claude.includes(key), false, 'WITNESS a failure after the rebuild is not absorbed by a doubled baseline');
});

test('a preserved grant that a newer failure had already outgrown is not re-preserved by revision 4', (t) => {
  const key = 'powershell:git status';
  const f = preservedByRevisionThree(t, { newerUnreconciledFailure: true });
  assert.ok(f.before.candidates[key].counts.failed > f.before.preservedEvidenceGrants[key].failureCountAtRebuild,
    'precondition: the revision-3 record no longer preserves the grant');
  const learn = createAutoLearnManager(f.options);
  assert.equal(learn.status().codexEvidence.pending, true);
  learn.scan({ platform: 'win32' });
  assert.equal(f.read().preservedEvidenceGrants[key], undefined, 'WITNESS the outgrown record is dropped, not refreshed');
  assert.deepEqual(f.read().applied, f.before.applied, 'the migration itself revokes nothing');
  learn.scan({ platform: 'win32' });
  assert.equal(f.read().applied.claude.includes(key), false, 'the next apply holds the grant to the normal rules, as it already would have');
});

// WHY IT IS HELD OPEN (2026-10-14, F3 of the v1.6.3 confirmation audit). The tests above pin that
// a missing root holds the rebuild; nothing told the user so. The scan now leads its Codex reasons
// with one that names the folder -- by NAME, never its path: reasons are persisted in
// lastScanStats, and the state file holds no history path and no `.jsonl` (as
// test/auto-learn-integration.test.js holds it). A reason, because the held rebuild keeps every
// family with Codex evidence off the auto-safe path and out of Review.
test('a missing root that holds the rebuild open is named, by folder name only, until it returns', (t) => {
  const f = twoRoots(t);
  const offline = `${f.rootB}-offline`;
  fs.renameSync(f.rootB, offline);

  const held = f.learn().scan({ platform: 'win32' });
  // MUTATION: drop the `rebuildHeldOpen ? [...] :` from lastScanStats.codexHistoryReasons in the
  // manager's scan. The scan says nothing about why its rebuild is open and this fails.
  // Confirmed 2026-10-14.
  assert.equal(held.codexHistoryReasons.length, 1, JSON.stringify(held.codexHistoryReasons));
  const [reason] = held.codexHistoryReasons;
  assert.match(reason, HELD_OPEN);
  assert.match(reason, /folder history-b\/ is missing, and 1 transcript\(s\) still owed a complete read/);
  assert.match(reason, /not applied, automatically or from Review/);
  assert.ok(!reason.includes(f.home) && !reason.includes(`${path.sep}history-b`), `a full path reached the reason: ${reason}`);
  assert.equal(held.codexHistoryStale, false, 'nothing diverged: the store is not stale, the rebuild is held');
  assert.equal(held.codexEvidence.pending, true, 'precondition: the rebuild is held');
  const stateText = fs.readFileSync(f.learn().paths.state, 'utf8');
  assert.deepEqual(JSON.parse(stateText).lastScanStats.codexHistoryReasons, [reason], 'persisted, for the dashboard');
  assert.doesNotMatch(stateText, /\.jsonl/i);
  for (const root of [f.rootA, f.rootB]) {
    assert.ok(!stateText.includes(JSON.stringify(root).slice(1, -1)), 'the state file gained a history root path');
  }

  // A second missing root is named beside the first, once each.
  const offlineA = `${f.rootA}-offline`;
  fs.renameSync(f.rootA, offlineA);
  const both = f.learn().scan({ platform: 'win32' });
  assert.match(both.codexHistoryReasons[0], /folders history-a\/, history-b\/ are missing/);
  fs.renameSync(offlineA, f.rootA);

  // Back: the rebuild completes and the reason goes with it.
  fs.renameSync(offline, f.rootB);
  const back = f.learn().scan({ platform: 'win32' });
  assert.equal(back.codexEvidence.pending, false);
  assert.deepEqual(back.codexHistoryReasons, [], 'a cleared condition left its reason behind');
});

// The other half of "only when the root is what holds it": a pending transcript the walk DID
// find is catching up on its own (a capped read), so a missing root beside it is not why the
// rebuild waits, and saying so would send the user looking for a folder that changes nothing.
test('a missing root beside a rebuild that waits only on a capped read is not named', (t) => {
  const f = fixture(t);
  const capped = () => ({ ...f.current, files: f.current.files.map((entry) => ({ ...entry, mode: 'partial' })),
    missingRoots: [{ path: path.join(f.home, 'gone-history'), source: 'codex', link: false }] });
  createAutoLearnManager({ ...f.options, historyScanner: capped }).scan();
  const again = createAutoLearnManager({ ...f.options, historyScanner: capped }).scan();
  assert.equal(again.codexEvidence.pending, true, 'precondition: the capped read keeps the rebuild open');
  assert.equal(again.codexEvidence.remainingFiles, 1, 'precondition: its one pending transcript was enumerated');
  // MUTATION: drop `owed <= 0` from rebuildHeldOpenReason's guard. The scan names gone-history/
  // as holding a rebuild it does not hold ("0 transcript(s) still owed") and this fails.
  // Confirmed 2026-10-14.
  assert.ok(!again.codexHistoryReasons.some((reason) => HELD_OPEN.test(reason)), JSON.stringify(again.codexHistoryReasons));
});
