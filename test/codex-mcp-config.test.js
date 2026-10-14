'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const api = require('../src/codex-mcp-config');

const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const copy = value => JSON.parse(JSON.stringify(value));
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-config-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), codexHome = path.join(root, 'codex'), workspaceRoot = path.join(root, 'workspace');
  for (const dir of [home, codexHome, workspaceRoot]) fs.mkdirSync(dir, { recursive: true });
  const file = path.join(codexHome, 'config.toml');
  let config = { mcp_servers: { 'Case.Server': { command: 'node', args: ['fixture-server.js'], enabled: true,
    default_tools_approval_mode: 'prompt', tools: { 'Tool.Name': { output_token_limit: 2000 }, neighbor: { approval_mode: 'prompt' } } } },
    projects: { fixture: { trust_level: 'untrusted' } }, foreign: { text: 'Keep café 🚀' } };
  let extraLayers = [], effectiveOverride = null, writes = 0;
  // The injected RPC models Codex's decoded layers and native serialization.
  // The separate actual-runtime check exercises real TOML and the subprocess.
  const save = () => fs.writeFileSync(file, '# user comment\n' + JSON.stringify(config, null, 2) + '\n');
  const version = () => 'sha256:' + hash(JSON.stringify(config));
  save();
  const rpc = requests => requests.map(request => {
    if (request.method === 'config/read') return { config: effectiveOverride || copy(config), origins: {}, layers: [
      { name: { type: 'user', file, profile: null }, version: version(), config: copy(config) }, ...copy(extraLayers),
    ] };
    assert.equal(request.method, 'config/value/write');
    assert.equal(request.params.filePath, file);
    assert.equal(request.params.expectedVersion, version(), 'native semantic version must match');
    const key = /^mcp_servers\."Case.Server"\.tools(?:\."([A-Za-z0-9_.-]+)"(?:\.(approval_mode))?)?$/.exec(request.params.keyPath);
    assert.ok(key, 'WITNESS exact dotted MCP names are quoted as individual key components');
    assert.equal(request.params.mergeStrategy, 'replace');
    writes++;
    const server = config.mcp_servers['Case.Server'];
    if (request.params.value === null) {
      if (!key[1]) delete server.tools;
      else if (!key[2]) delete server.tools[key[1]];
      else delete server.tools[key[1]].approval_mode;
    } else {
      server.tools ||= {}; server.tools[key[1]] ||= {};
      server.tools[key[1]].approval_mode = request.params.value;
    }
    save();
    return { filePath: file, status: 'ok', version: version() };
  });
  const options = { home, codexHome, workspaceRoot, server: 'Case.Server', tool: 'Tool.Name', rpc };
  const ledger = () => path.join(home, '.ai-acolyte', fs.readdirSync(path.join(home, '.ai-acolyte')).find(name => /^codex-mcp\..*\.json$/.test(name)));
  return { root, file, home, codexHome, options, save, ledger,
    get config() { return config; }, set config(value) { config = value; },
    get writes() { return writes; }, set extraLayers(value) { extraLayers = value; },
    set effective(value) { effectiveOverride = value; } };
}
const request = plan => ({ server: plan.server, tool: plan.tool, expectedFingerprint: plan.fingerprint });

test('MCP config plan binds exact user source bytes and never starts a write', t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  const plan = api.planCodexMcpApproval(f.options);
  assert.equal(plan.supported, true);
  assert.equal(plan.source.path, f.file);
  assert.equal(plan.source.hash, hash(before));
  assert.match(plan.source.version, /^sha256:/);
  assert.equal(plan.source.origin, 'user');
  assert.equal(plan.reviewRequired, true);
  assert.equal(plan.autoApply, false);
  assert.equal(plan.normalizesLineEndings, true);
  assert.equal(plan.explicitApprovalMode, null);
  assert.equal(plan.effectiveApprovalMode, 'prompt');
  assert.equal(f.writes, 0);
  assert.equal(fs.existsSync(path.join(f.home, '.ai-acolyte')), false);
  assert.deepEqual(fs.readFileSync(f.file), before);
  assert.equal(JSON.stringify(plan).includes('fixture-server.js'), false, 'transport arguments are not exposed by the inspection');
});

test('MCP config apply changes only reviewed exact leaf and receipt restoration preserves siblings trust and metadata', t => {
  const f = fixture(t), original = copy(f.config), before = fs.readFileSync(f.file);
  const applied = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), f.options);
  assert.equal(applied.changed, true);
  assert.equal(f.config.mcp_servers['Case.Server'].tools['Tool.Name'].approval_mode, 'approve');
  const expected = copy(original); expected.mcp_servers['Case.Server'].tools['Tool.Name'].approval_mode = 'approve';
  assert.deepEqual(f.config, expected, 'WITNESS exact MCP approval preserves sibling metadata and trust');
  assert.deepEqual(fs.readFileSync(applied.backupPath), before);
  assert.ok(!applied.backupPath.startsWith(f.codexHome));
  assert.equal(api.inspectPending(f.options), null);
  const listed = api.listCodexMcpApprovals({ ...f.options, rpc: () => { throw new Error('Inventory must not start config RPC'); } });
  assert.deepEqual(listed.map(item => [item.id, item.undoable, item.restored]), [[applied.receiptId, true, false]],
    'WITNESS global MCP receipt lists an exact currently restorable approval');
  assert.deepEqual(listed[0].beforeApproval, { exists: false, value: null });
  assert.equal(listed[0].afterHash, applied.afterHash);
  assert.equal(JSON.stringify(listed).includes('fixture-server.js'), false);
  const noop = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), f.options);
  assert.equal(noop.changed, false);
  assert.equal(JSON.parse(fs.readFileSync(f.ledger(), 'utf8')).receipts.length, 1,
    'WITNESS an already-approved exact leaf creates no additional ownership receipt');
  const restored = api.restoreCodexMcpApproval(applied.receiptId, f.options);
  assert.equal(restored.changed, true);
  assert.deepEqual(f.config, original, 'WITNESS receipt restoration changes only the previously selected approval leaf');
  assert.deepEqual(api.listCodexMcpApprovals(f.options).map(item => [item.undoable, item.restored]), [[false, true]]);
  assert.throws(() => api.restoreCodexMcpApproval(applied.receiptId, f.options), /already restored/);
});

test('MCP config refuses stale review including comment-only changes before any intent or write', t => {
  const f = fixture(t), plan = api.planCodexMcpApproval(f.options);
  fs.appendFileSync(f.file, '# concurrent comment\n');
  assert.throws(() => api.applyCodexMcpApproval(request(plan), f.options), /changed after review/,
    'WITNESS semantic version alone cannot approve changed config bytes');
  assert.equal(f.writes, 0);
  assert.equal(fs.existsSync(path.join(f.home, '.ai-acolyte')), false);
  const fresh = api.planCodexMcpApproval(f.options);
  assert.notEqual(fresh.fingerprint, plan.fingerprint);
  assert.throws(() => api.applyCodexMcpApproval({ server: fresh.server, tool: fresh.tool }, f.options), /changed after review/);
});

test('MCP config disabled absent plugin and other-layer authority stays read-only', t => {
  const f = fixture(t), original = copy(f.config);
  const cases = [
    () => { delete f.config.mcp_servers['Case.Server']; },
    () => { f.config.mcp_servers['Case.Server'].enabled = false; },
    () => { f.config.mcp_servers['Case.Server'].disabled_tools = ['Tool.Name']; },
    () => { f.config.mcp_servers['Case.Server'].enabled_tools = ['neighbor']; },
    () => { f.config.mcp_servers['Case.Server'].tools['Tool.Name'].enabled = false; },
    () => { f.extraLayers = [{ name: { type: 'project', dotCodexFolder: 'project' }, config: { mcp_servers: { 'Case.Server': { enabled: true } } } }]; },
    () => { const current = copy(f.config); current.mcp_servers['Case.Server'].enabled = false; f.effective = current; },
  ];
  for (const change of cases) {
    f.config = copy(original); f.extraLayers = []; f.effective = null; change(); f.save();
    const result = api.inspectCodexMcpTool(f.options);
    assert.equal(result.supported, false, 'WITNESS disabled or non-user MCP authority cannot be widened');
    assert.equal(typeof result.reason, 'string');
  }
  assert.equal(f.writes, 0);
  f.config = copy(original); f.extraLayers = []; f.effective = null; f.save();
  assert.equal(api.inspectCodexMcpTool(f.options).supported, true);
});

test('MCP prepared intent blocks writers and cancels only explicitly accepted untouched bytes', t => {
  const f = fixture(t), before = fs.readFileSync(f.file);
  const planned = api.planCodexMcpApproval(f.options);
  assert.throws(() => api.applyCodexMcpApproval(request(planned), { ...f.options, afterIntent: () => { throw new Error('interrupted before write'); } }), /interrupted/);
  const pending = api.inspectPending(f.options);
  assert.ok(pending, 'WITNESS durable MCP intent exists before native policy write');
  assert.equal(f.writes, 0);
  assert.throws(() => api.assertReady(f.options), /pending/);
  assert.throws(() => api.applyCodexMcpApproval(request(planned), f.options), /pending/,
    'WITNESS unfinished MCP intent blocks every new approval');
  assert.throws(() => api.finishPending({ id: pending.id, acceptedHash: '0'.repeat(64) }, f.options), /accept the current/);
  assert.equal(api.finishPending({ id: pending.id, acceptedHash: hash(before) }, f.options).cancelled, true);
  assert.equal(api.inspectPending(f.options), null);
  assert.deepEqual(fs.readFileSync(f.file), before);
});

test('MCP written intent recovers exact planned semantics and refuses concurrent semantic edits', t => {
  const f = fixture(t);
  assert.throws(() => api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)),
    { ...f.options, afterWrite: () => { throw new Error('interrupted after write'); } }), /interrupted/);
  const pending = api.inspectPending(f.options), intended = copy(f.config);
  f.config.foreign.text = 'Manual semantic edit'; f.save();
  const changed = fs.readFileSync(f.file), ledgerBefore = fs.readFileSync(f.ledger());
  assert.throws(() => api.finishPending({ id: pending.id, acceptedHash: hash(changed) }, f.options), /unexpected semantics/,
    'WITNESS pending MCP recovery cannot accept an unrelated semantic change');
  assert.deepEqual(fs.readFileSync(f.file), changed);
  assert.deepEqual(fs.readFileSync(f.ledger()), ledgerBefore);
  f.config = intended; f.save();
  const recovered = api.finishPending({ id: pending.id, acceptedHash: hash(fs.readFileSync(f.file)) }, f.options);
  assert.equal(recovered.recovered, true);
  assert.equal(api.inspectPending(f.options), null);
  assert.equal(f.writes, 1, 'WITNESS finishing a native write never retries it');
});

test('MCP receipt restoration refuses changed config and damaged backup without policy edits', t => {
  const f = fixture(t), applied = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), f.options);
  const after = fs.readFileSync(f.file);
  fs.appendFileSync(f.file, '# user edit\n');
  assert.throws(() => api.restoreCodexMcpApproval(applied.receiptId, f.options), /changed after this approval/,
    'WITNESS receipt restoration cannot overwrite changed config');
  assert.equal(f.writes, 1);
  assert.equal(api.listCodexMcpApprovals(f.options)[0].undoable, false,
    'WITNESS changed config is not advertised as restorable');
  fs.writeFileSync(f.file, after); fs.writeFileSync(applied.backupPath, 'damaged');
  assert.throws(() => api.restoreCodexMcpApproval(applied.receiptId, f.options), /backup is missing or changed/,
    'WITNESS a damaged backup cannot supply restoration authority');
  assert.equal(f.writes, 1);
  assert.equal(api.inspectPending(f.options), null);
});

test('MCP sequential receipts unwind only newly created tool structure and preserve existing empty tables', t => {
  for (const existingTools of [null, {}, { neighbor: {} }]) {
    // Each case owns fresh receipts so full hash equality is meaningful.
    const c = fixture(t);
    if (existingTools === null) delete c.config.mcp_servers['Case.Server'].tools;
    else c.config.mcp_servers['Case.Server'].tools = copy(existingTools);
    c.save();
    const original = copy(c.config);
    const a = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(c.options)), c.options);
    const afterA = fs.readFileSync(c.file);
    const optionsB = { ...c.options, tool: 'Second.Tool' };
    const b = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(optionsB)), optionsB);
    assert.throws(() => api.restoreCodexMcpApproval(a.receiptId, c.options), /changed after this approval/);
    api.restoreCodexMcpApproval(b.receiptId, c.options);
    assert.deepEqual(fs.readFileSync(c.file), afterA, 'WITNESS later MCP Undo restores the earlier approval structure');
    api.restoreCodexMcpApproval(a.receiptId, c.options);
    assert.deepEqual(c.config, original, 'WITNESS sequential MCP Undo preserves pre-existing empty tables');
  }
});

test('MCP linked profile and receipt parents are refused before following another scope', t => {
  const f = fixture(t), alias = path.join(f.root, 'linked-codex');
  fs.symlinkSync(f.codexHome, alias, process.platform === 'win32' ? 'junction' : 'dir');
  const inspected = api.inspectCodexMcpTool({ ...f.options, codexHome: alias, rpc: requests => {
    const responses = f.options.rpc(requests);
    responses[0].layers[0].name.file = path.join(alias, 'config.toml');
    return responses;
  } });
  assert.equal(inspected.supported, false, 'WITNESS a linked profile cannot alias MCP source authority');
  assert.match(inspected.reason, /Linked or non-directory/);
  const foreign = path.join(f.root, 'foreign-ledger'); fs.mkdirSync(foreign);
  fs.symlinkSync(foreign, path.join(f.home, '.ai-acolyte'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), f.options), /Linked or non-directory/,
    'WITNESS linked receipt parents cannot redirect MCP approval backups');
  assert.equal(f.writes, 0);
  assert.deepEqual(fs.readdirSync(foreign), []);
});

test('MCP malformed durable records and unsupported native config RPC fail visibly without a fallback writer', t => {
  const f = fixture(t);
  const unsupported = api.inspectCodexMcpTool({ ...f.options, rpc: () => { throw new Error('method not supported'); } });
  assert.equal(unsupported.supported, false);
  assert.match(unsupported.reason, /method not supported/);
  const applied = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), f.options);
  const ledger = JSON.parse(fs.readFileSync(f.ledger(), 'utf8'));
  for (const malformed of [{ ...ledger, version: 99 }, { ...ledger, scope: 'other' },
    { ...ledger, receipts: [ledger.receipts[0], ledger.receipts[0]] },
    { ...ledger, pending: { ...ledger.receipts[0], id: 'bad' } }]) {
    fs.writeFileSync(f.ledger(), JSON.stringify(malformed));
    assert.throws(() => api.assertReady(f.options), /malformed|unsupported|duplicate/,
      'WITNESS corrupt MCP intent or receipts cannot be silently reset');
  }
  assert.equal(f.writes, 1);
  assert.ok(fs.existsSync(applied.backupPath));
});

test('MCP written recovery retains intent when its exact pre-change backup is damaged', t => {
  const f = fixture(t);
  assert.throws(() => api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)),
    { ...f.options, afterWrite: () => { throw new Error('interrupted after write'); } }), /interrupted/);
  const pending = api.inspectPending(f.options), original = fs.readFileSync(pending.backupPath);
  fs.writeFileSync(pending.backupPath, 'damaged');
  const ledger = fs.readFileSync(f.ledger());
  assert.throws(() => api.finishPending({ id: pending.id, acceptedHash: pending.currentHash }, f.options), /backup is missing or changed/,
    'WITNESS a written intent cannot become an approval receipt without its exact prior backup');
  assert.deepEqual(fs.readFileSync(f.ledger()), ledger);
  fs.writeFileSync(pending.backupPath, original);
  assert.equal(api.finishPending({ id: pending.id, acceptedHash: pending.currentHash }, f.options).recovered, true);
});

test('MCP receipt ledger rejects invented or duplicate restoration authority', t => {
  const f = fixture(t), approved = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), f.options);
  api.restoreCodexMcpApproval(approved.receiptId, f.options);
  const original = JSON.parse(fs.readFileSync(f.ledger(), 'utf8'));
  for (const change of [
    state => { state.receipts[1].restores = '0'.repeat(32); },
    state => { state.receipts[1].server = 'OtherServer'; },
    state => { state.receipts[1].beforeHash = '0'.repeat(64); },
    state => { state.receipts.push({ ...state.receipts[1], id: 'f'.repeat(32) }); },
  ]) {
    const state = copy(original); change(state); fs.writeFileSync(f.ledger(), JSON.stringify(state));
    assert.throws(() => api.listCodexMcpApprovals(f.options), /invalid receipt authority/,
      'WITNESS restore metadata cannot invent or reuse another approval receipt');
  }
});

test('MCP explicit previous approval modes remain visible and restore without changing defaults', t => {
  for (const mode of ['auto', 'prompt', 'writes']) {
    const f = fixture(t); f.config.mcp_servers['Case.Server'].tools['Tool.Name'].approval_mode = mode; f.save();
    const original = copy(f.config);
    const approved = api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), f.options);
    assert.deepEqual(api.listCodexMcpApprovals(f.options)[0].beforeApproval, { exists: true, value: mode },
      'WITNESS the prior explicit mode remains available for Undo review');
    api.restoreCodexMcpApproval(approved.receiptId, f.options);
    assert.deepEqual(f.config, original, 'WITNESS Undo restores the prior mode rather than broad server defaults');
  }
});

test('MCP intent rechecks exact bytes immediately before native write', t => {
  const f = fixture(t);
  assert.throws(() => api.applyCodexMcpApproval(request(api.planCodexMcpApproval(f.options)), { ...f.options,
    afterIntent: () => fs.appendFileSync(f.file, '# concurrent after intent\n'),
  }), /changed after review/,
  'WITNESS a comment edit after intent cannot pass the native semantic-version guard alone');
  assert.equal(f.writes, 0);
  assert.ok(api.inspectPending(f.options));
  assert.match(fs.readFileSync(f.file, 'utf8'), /concurrent after intent/);
});

// THE ASYNCHRONOUS READ (2026-10-14): the extension host's trust ask, launched with
// spawn instead of spawnSync. Driven through the REAL worker against a stand-in
// codex that starts and then never answers, which is the case that blocked the host
// for 31 s on the synchronous route. Bounded end to end by `timeoutMs`, and the
// worker's own deadline kills its codex, so nothing is left behind even with no
// deactivate to end it.
function hangingCodex(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-hang-'));
  t.after(() => { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} });
  const pidFile = path.join(dir, 'pid');
  const script = path.join(dir, 'hang.js');
  fs.writeFileSync(script, `require('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  if (process.platform === 'win32') {
    const shim = path.join(dir, 'codex.cmd');
    fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
    return { executable: shim, pidFile };
  }
  const shim = path.join(dir, 'codex');
  fs.writeFileSync(shim, `#!/bin/sh\nexec "${process.execPath}" "${script}" "$@"\n`, { mode: 0o755 });
  return { executable: shim, pidFile };
}

test('the asynchronous layers read does not block, is bounded, hands its child over, and leaves no codex running', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-async-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const codex = hangingCodex(t);
  const tracked = [];
  const started = Date.now();
  // 8 s, not 4 (2026-10-14). The worker's deadline is the budget less 3 s, so 4 s gave it 1 s to
  // start node and spawn the stand-in. Under suite load it started later, and since 1cf20d0 a
  // worker already past its deadline spawns nothing. The pid file was then absent (ENOENT, 2 of
  // 4 loaded runs, wave-g1). 5 s keeps the spawn-then-kill path this test is about the normal one;
  // the late-start path has its own test below.
  const reading = api.readCodexConfigLayersAsync({ home, codexHome, workspaceRoot: root, codexExecutable: codex.executable,
    timeoutMs: 8000, track: child => tracked.push(child) });
  assert.ok(Date.now() - started < 1000, 'the call returned before Codex answered: nothing here waits synchronously');
  assert.equal(tracked.length, 1, 'the worker is handed to the caller, so a deactivate can end it');
  // The WORKER's deadline, not this side's backstop: the worker is the one that
  // can end its own codex gracefully, so it has to be the one that fires first.
  // MUTATION: drop `deadlineAt` from the worker request. The worker waits its 25 s
  // default, the 8 s backstop tree-kills it instead, and the reason reads
  // "unavailable: the worker timed out". Confirmed 2026-10-14 (as `deadlineMs`
  // before the deadline became a time, and again after).
  await assert.rejects(reading, /refused: Codex config operation timed out/,
    'a codex that never answers ends as the worker timing it out, not as a hang');
  // Read at the moment the answer landed, before anything else awaits.
  const workerLiveAtAnswer = tracked[0].exitCode === null && tracked[0].signalCode === null;
  const elapsed = Date.now() - started;
  assert.ok(elapsed < 10000, `bounded by its 8 s budget plus a kill: took ${elapsed} ms`);
  // A worker that still started past its deadline spawned nothing; that path is pinned by "a worker
  // that starts after its deadline answers before the host's backstop". Here, only a codex that
  // was started has to be shown dead.
  if (fs.existsSync(codex.pidFile)) {
    // THE ANSWER IS THE LINE, NOT THE EXIT (2026-10-14). A worker that started a codex spends
    // its 1 s grace and a tree kill after its answer, so the answer lands while it is still
    // alive. MUTATION: drop the `answer(...)` call in nativeRpcAsync's stdout handler, so the
    // call settles only on 'close'. The worker has exited by then and this fails; on a slow
    // runner the backstop also wins (CI run 38600144147). Confirmed 2026-10-14.
    assert.equal(workerLiveAtAnswer, true, 'the answer settled the call before the worker finished its cleanup');
    const pid = Number(fs.readFileSync(codex.pidFile, 'utf8'));
    let alive = true;
    // 10 s, not 2: the call now settles before the cleanup, so the kill still has its grace
    // and a taskkill to run.
    for (let wait = 0; wait < 200 && alive; wait += 1) {
      try { process.kill(pid, 0); await new Promise(resolve => setTimeout(resolve, 50)); } catch { alive = false; }
    }
    assert.equal(alive, false, 'the worker tree-killed the codex it started');
  }
  await assert.rejects(api.readCodexConfigLayersAsync({ home, codexHome, codexExecutable: codex.executable,
    rpc: () => Promise.resolve([{ config: {} }]) }), /did not return layers/, 'an injected route is checked like the real one');
});

// A WORKER THAT STARTS LATE STILL ENDS ITS OWN CODEX FIRST (2026-10-14). CI run
// 38535034218 failed the test above on Node 20 / windows-latest only: the worker's
// deadline was a length counted from its own start, so a slow start was taken out
// of the 3 s margin its grace and its kill need, and the host's backstop got there
// first ("unavailable: the worker timed out"). Here the start is slow on purpose: a
// --require preload, active only in the process that runs --rpc-worker, holds it
// for 5.5 s, past the 5 s deadline an 8 s budget sets. The deadline is a time now,
// and a worker already past it fails the call before it spawns anything, so no grace
// and no kill are needed at all. Until 2026-10-14 it still spawned the app-server
// first, and under load the spawn, the start, the grace and the kill overran the 3 s
// left (the masked suite, 8.9 s, once).
test('a worker that starts after its deadline answers before the host\'s backstop', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-late-'));
  t.after(async () => {
    await waitFor(() => { try { fs.rmSync(root, { recursive: true, force: true }); return true; } catch { return false; } }, 5000);
  });
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const codex = hangingCodex(t);
  const preload = path.join(root, 'slow-worker.js');
  fs.writeFileSync(preload, "if (process.argv.includes('--rpc-worker')) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5500);\n");
  const saved = process.env.NODE_OPTIONS;
  // NODE_OPTIONS reads a backslash inside quotes as an escape: forward slashes.
  process.env.NODE_OPTIONS = `--require "${preload.split(path.sep).join('/')}"`;
  const started = Date.now();
  let reading;
  try {
    reading = api.readCodexConfigLayersAsync({ home, codexHome, workspaceRoot: root, codexExecutable: codex.executable,
      timeoutMs: 8000 }).then(() => 'answered', error => error.message);
  } finally {
    if (saved === undefined) delete process.env.NODE_OPTIONS; else process.env.NODE_OPTIONS = saved;
  }
  const outcome = await reading;
  const elapsed = Date.now() - started;
  assert.ok(elapsed >= 5500, `precondition: the worker really started late (answered after ${elapsed} ms)`);
  // MUTATION: make the deadline a length again (send `timeoutMs - 3000` as
  // `deadlineAt` and arm it as is in the worker). It is armed 5 s after the late
  // start, the 8 s backstop fires first, and this reads "unavailable: the worker
  // timed out". Confirmed 2026-10-14.
  assert.match(outcome, /refused: Codex config operation timed out/, 'the worker\'s deadline, not the host\'s backstop');
  // MUTATION: drop the worker's deadline check before its spawn. The app-server starts and,
  // within the 1 s grace, writes its pid, so this fails. Confirmed 2026-10-14.
  await new Promise((resolve) => setTimeout(resolve, 1500));
  const codexStarted = fs.existsSync(codex.pidFile);
  if (codexStarted) {
    const pid = Number(fs.readFileSync(codex.pidFile, 'utf8'));
    t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  }
  assert.equal(codexStarted, false, 'a worker already past its deadline starts no codex');
});

const gone = pid => { try { process.kill(pid, 0); return false; } catch { return true; } };
async function waitFor(predicate, ms) {
  const start = Date.now();
  while (!predicate() && Date.now() - start < ms) await new Promise(resolve => setTimeout(resolve, 50));
  return predicate();
}

// THE TREE KILL REACHES THE CODEX ON POSIX TOO (2026-10-14). The worker's
// `detached` went through execFile, which drops it, so the worker never led a
// process group, endProcessTree's group signal failed with ESRCH, and the kill
// deactivate makes ended the worker alone: on every Ubuntu CI leg of run
// 38525363435 the hung codex outlived it. Driven through the real worker and the
// real endProcessTree, which is deactivate's own path (killLiveChildren). The
// worker's deadline here is its 25 s ceiling, so within the 3 s this waits only
// the kill can have ended the codex.
test('a tree kill of the asynchronous worker ends the codex it started, on every platform', async t => {
  const { endProcessTree } = require('../src/exec-resolve');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-tree-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const codex = hangingCodex(t);
  const tracked = [];
  const outcome = api.readCodexConfigLayersAsync({ home, codexHome, workspaceRoot: root, codexExecutable: codex.executable,
    timeoutMs: 40000, track: child => tracked.push(child) }).then(() => 'answered', error => error.message);
  t.after(() => { for (const child of tracked) { try { child.kill('SIGKILL'); } catch {} } });
  assert.ok(await waitFor(() => fs.existsSync(codex.pidFile) && fs.readFileSync(codex.pidFile, 'utf8').trim(), 10000),
    'precondition: the worker started the stand-in codex');
  const pid = Number(fs.readFileSync(codex.pidFile, 'utf8'));
  t.after(() => { try { process.kill(pid, 'SIGKILL'); } catch {} });
  assert.equal(gone(pid), false, 'precondition: the stand-in codex is running');
  if (process.platform !== 'win32') {
    // MUTATION: spawn the worker with `detached: false`, which is what execFile
    // made of `detached: true`. No group carries the worker's PID and this throws
    // ESRCH. Confirmed 2026-10-14.
    assert.doesNotThrow(() => process.kill(-tracked[0].pid, 0), 'the worker leads a process group of its own');
  }
  await endProcessTree(tracked[0]);
  // MUTATION: spawn the app-server `detached` in the worker. It leads a group of
  // its own, the host's group signal misses it, and it is still running here.
  // Confirmed 2026-10-14.
  assert.equal(await waitFor(() => gone(pid), 3000), true, 'the codex under the worker was ended with it');
  assert.match(await outcome, /^Codex config RPC is unavailable: Command failed: the worker exited/,
    'a killed worker reads as unavailable, the way the execFile route reported it');
});

// A WORKER WHOSE HOST DIES ENDS ITS CODEX AND EXITS (2026-10-14). The tree kill
// above needs a host alive to send it. Killed outright, the host sends nothing:
// on Linux the worker (a group and session of its own, so not even a signal to
// the host's group reaches it) ran to its 25 s deadline and then died writing its
// answer to the dead host (EPIPE, unhandled), after its kill was armed and before
// it fired, and the hung codex was still running 30 s after the host. The host
// here is a real Node process running the real module, killed with SIGKILL.
//
// WINDOWS IS DIFFERENT, AND HAS A RESIDUAL. libuv puts every child a Node process
// spawns in a kill-on-close job object, so the worker dies WITH its host, before
// its own watch can run; that is pinned below. The same job allows silent
// breakaway, so a `.cmd` codex's node, a grandchild through cmd.exe, is in neither
// job and outlives an abrupt host death (measured 2026-10-14 with this stand-in,
// which never reads its stdin; a codex that reads it sees EOF when the worker
// dies). Deactivate's taskkill /T is unaffected: it runs while the host is alive.
// Since 2026-10-14 the shim npm itself writes is run as its node script instead
// (src/exec-resolve.js, npmShimLaunch; the next test), so this stand-in, a
// two-line .cmd of no generator's making, is the shape the residual is left with.
test('a worker whose host dies outright ends the codex it started and exits', async t => {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-host-death-'));
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const workerPidFile = path.join(root, 'worker.pid');
  // One hook, in this order: on Windows the surviving stand-in runs with its cwd in
  // `home`, and a directory a live process stands in cannot be removed. Its hidden
  // console host stands there for about a second more after it dies, and Node 24's
  // rmSync does not retry that EPERM itself (measured 2026-10-14), so retry here.
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await waitFor(() => pids.every(gone), 3000);
    await waitFor(() => { try { fs.rmSync(root, { recursive: true, force: true }); return true; } catch { return false; } }, 5000);
  });
  const codex = hangingCodex(t);
  const host = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'codex-mcp-config.js'))}).readCodexConfigLayersAsync({
      home: ${JSON.stringify(home)}, codexHome: ${JSON.stringify(codexHome)}, workspaceRoot: ${JSON.stringify(root)},
      codexExecutable: ${JSON.stringify(codex.executable)}, timeoutMs: 40000,
      track: child => require('fs').writeFileSync(${JSON.stringify(workerPidFile)}, String(child.pid)),
    }).catch(() => {});
    setInterval(() => {}, 1000);`], { stdio: 'ignore', windowsHide: true });
  pids.push(host.pid);
  const readPid = file => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) || null : null);
  assert.ok(await waitFor(() => readPid(codex.pidFile) && readPid(workerPidFile), 10000),
    'precondition: the host started the worker and the worker started the stand-in codex');
  const worker = readPid(workerPidFile), hung = readPid(codex.pidFile);
  pids.push(worker, hung);
  host.kill('SIGKILL');
  // The worker's deadline is its 25 s ceiling, so within these 5 s only noticing
  // the host's death can have ended either of them.
  // MUTATION: drop the worker's host watch. It waits out its deadline and this
  // fails on Linux. Confirmed 2026-10-14.
  assert.equal(await waitFor(() => gone(worker), 5000), true, 'the worker outlived its host');
  if (process.platform === 'win32') return;
  // MUTATION: drop the worker's stdout 'error' listener. The watch fires, the
  // answer's write to the dead host is EPIPE, the worker dies of it, and the
  // codex is still running here. Confirmed 2026-10-14.
  assert.equal(await waitFor(() => gone(hung), 3000), true, 'the codex under the worker outlived the host');
});

// AN npm CODEX NO LONGER OUTLIVES A HOST THAT DIES OUTRIGHT, ON WINDOWS EITHER
// (2026-10-14). The case above, with the shim npm itself writes, generated by the
// cmd-shim bundled with the node running this suite. The worker runs the shim's
// node script directly, so that node is the worker's own child, in the worker's
// kill-on-close job, and dies when the host's job ends the worker.
test('on Windows, an npm-shim codex dies with a host that dies outright', { skip: process.platform !== 'win32' }, async t => {
  let cmdShim;
  try { cmdShim = require(path.join(path.dirname(process.execPath), 'node_modules', 'npm', 'node_modules', 'cmd-shim')); }
  catch { t.skip('npm\'s bundled cmd-shim is not next to this node'); return; }
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-npm-death-'));
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await waitFor(() => pids.every(gone), 3000);
    await waitFor(() => { try { fs.rmSync(root, { recursive: true, force: true }); return true; } catch { return false; } }, 5000);
  });
  const npm = path.join(root, 'npm');
  const bin = path.join(npm, 'node_modules', '@openai', 'codex', 'bin');
  fs.mkdirSync(bin, { recursive: true });
  const pidFile = path.join(root, 'codex.pid'), workerPidFile = path.join(root, 'worker.pid');
  fs.writeFileSync(path.join(bin, 'codex.js'),
    `#!/usr/bin/env node\nrequire('fs').writeFileSync(${JSON.stringify(pidFile)}, String(process.pid)); setInterval(() => {}, 1000);\n`);
  await cmdShim(path.join(bin, 'codex.js'), path.join(npm, 'codex'));
  const host = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'codex-mcp-config.js'))}).readCodexConfigLayersAsync({
      home: ${JSON.stringify(home)}, codexHome: ${JSON.stringify(codexHome)}, workspaceRoot: ${JSON.stringify(root)},
      codexExecutable: ${JSON.stringify(path.join(npm, 'codex.cmd'))}, timeoutMs: 40000,
      track: child => require('fs').writeFileSync(${JSON.stringify(workerPidFile)}, String(child.pid)),
    }).catch(() => {});
    setInterval(() => {}, 1000);`], { stdio: 'ignore', windowsHide: true });
  pids.push(host.pid);
  const readPid = file => (fs.existsSync(file) ? Number(fs.readFileSync(file, 'utf8').trim()) || null : null);
  assert.ok(await waitFor(() => readPid(pidFile) && readPid(workerPidFile), 10000),
    'precondition: the host started the worker and the worker started the npm codex');
  const worker = readPid(workerPidFile), hung = readPid(pidFile);
  pids.push(worker, hung);
  host.kill('SIGKILL');
  assert.equal(await waitFor(() => gone(worker), 5000), true, 'the worker outlived its host');
  // MUTATION: launch the app-server with commandLaunch alone again (drop
  // npmShimLaunch in the worker). The shim's node is a grandchild through cmd.exe,
  // in neither job, and it is still running here. Confirmed 2026-10-14.
  assert.equal(await waitFor(() => gone(hung), 3000), true, 'the npm codex outlived the host');
});

// THE WORKER'S OWN KILL RUNS SYSTEM32's taskkill TOO (2026-10-14). The worker
// inherits the host's cwd, and its grace kill named taskkill bare, which libuv
// looks for in the cwd first unless NoDefaultCurrentDirectoryInExePath is set
// (src/exec-resolve.js, taskkillPath). The host here is a real Node process
// standing in a directory that holds a copy of node named taskkill.exe; a
// --require preload writes a flag only when it runs as that copy. With a 4 s
// budget the worker's deadline is 1 s and its grace 1 s, so its own kill is the
// one that ends the stand-in codex, well inside the host's backstop. The flag is
// not the only witness: endpoint scanning can hold the first run of a freshly
// copied executable past the 4 s, and then the copy dies before its preload runs.
// The answer is the witness that holds either way: only a kill that worked lets
// the worker report its own deadline instead of the host's backstop.
test('the config worker\'s own kill runs System32\'s taskkill, not one planted in its cwd', { skip: process.platform !== 'win32' }, async t => {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-planted-'));
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await waitFor(() => { try { fs.rmSync(root, { recursive: true, force: true }); return true; } catch { return false; } }, 5000);
  });
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex'), cwd = path.join(root, 'cwd');
  fs.mkdirSync(codexHome, { recursive: true });
  fs.mkdirSync(cwd, { recursive: true });
  const flag = path.join(root, 'planted-taskkill-ran');
  const marker = path.join(root, 'planted-marker.js');
  fs.writeFileSync(marker, `if (/taskkill\\.exe$/i.test(process.execPath)) require('fs').writeFileSync(${JSON.stringify(flag)}, process.argv.slice(1).join(' '));\n`);
  fs.copyFileSync(process.execPath, path.join(cwd, 'taskkill.exe'));
  const codex = hangingCodex(t);
  const env = { ...process.env, NODE_OPTIONS: `--require "${marker.split(path.sep).join('/')}"` };
  // An agent shell often sets this, and with it set the unfixed code passes too.
  delete env.NoDefaultCurrentDirectoryInExePath;
  const host = spawn(process.execPath, ['-e', `
    require(${JSON.stringify(path.join(__dirname, '..', 'src', 'codex-mcp-config.js'))}).readCodexConfigLayersAsync({
      home: ${JSON.stringify(home)}, codexHome: ${JSON.stringify(codexHome)}, workspaceRoot: ${JSON.stringify(root)},
      codexExecutable: ${JSON.stringify(codex.executable)}, timeoutMs: 4000,
    }).then(() => process.stdout.write('answered'), error => process.stdout.write(error.message));`],
  { cwd, env, stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  pids.push(host.pid);
  const started = Date.now();
  let outcome = '';
  host.stdout.setEncoding('utf8');
  host.stdout.on('data', chunk => { outcome += chunk; });
  await new Promise(resolve => host.once('close', resolve));
  // Said in every message below, so a failure on a loaded runner names its path.
  outcome = `${outcome} (the host answered after ${Date.now() - started} ms)`;
  assert.ok(fs.existsSync(codex.pidFile), `precondition: the stand-in codex started; the host said: ${outcome}`);
  const hung = Number(fs.readFileSync(codex.pidFile, 'utf8'));
  pids.push(hung);
  // MUTATION: name 'taskkill' bare in the worker's grace kill again (since 2026-10-14
  // that kill is endProcessTree's, so in src/exec-resolve.js). The copy in
  // the cwd runs instead (writing the flag once it is past the scan), the stand-in
  // survives until the host's backstop ends the worker's tree, and the answer is
  // "unavailable: the worker timed out". Confirmed 2026-10-14: both, on separate runs,
  // and again through endProcessTree.
  assert.equal(fs.existsSync(flag), false,
    `the taskkill in the worker's cwd ran: ${fs.existsSync(flag) ? fs.readFileSync(flag, 'utf8') : ''}; the host said: ${outcome}`);
  assert.match(outcome, /refused: Codex config operation timed out/, `the worker's deadline, not the host's backstop; the host said: ${outcome}`);
  assert.equal(await waitFor(() => gone(hung), 3000), true, 'the worker\'s kill ended the stand-in codex');
});

// THE WORKER'S GRACE KILL IS NEVER AIMED AT A FREED PID (2026-10-14), the guard
// endProcessTree gained in 6dfe60b. The grace kill read `exitCode` alone, and a child
// that exited by a signal has `signalCode` instead, so by its 'exit' Node has closed its
// handle and its PID is free. Not reachable in the shipped worker: on Windows
// `signalCode` is set only by this process's own child.kill(), which the worker never
// calls there, and on POSIX child.kill() after 'exit' sends nothing, which is also why
// this is Windows-only. So the state is DRIVEN, in the real worker, by a --require
// preload. It ends the app-server with child.kill() as the worker's finally begins, so
// the exit is a real one by a signal. The stand-in is cmd.exe -> node, and the node holds
// the stdout cmd.exe handed it for 3 s more, so 'close' comes after the 1 s grace and the
// grace kill has to decide. The preload records every taskkill and runs none.
//
// THE KILL WAITS FOR THE NODE TO RUN. The first version's finally came at a 1.5 s deadline,
// and once, under two suites at once, cmd.exe was killed while still inside CreateProcess
// for the node: that node was left with one thread and no CPU time ten minutes later, never
// resumed, holding the stdout pipe, so 'close' never came and the suite hung (recorded under
// "Process-spawn residuals"). Now the stand-in refuses `initialize`, so the worker reaches its
// finally only once the node is running, and each run is bounded.
test('the config worker\'s grace kill skips an app-server that exited by a signal, and still ends a live one', { skip: process.platform !== 'win32' }, async t => {
  const { spawn } = require('node:child_process');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-mcp-grace-'));
  const home = path.join(root, 'home'), codexHome = path.join(home, '.codex');
  fs.mkdirSync(codexHome, { recursive: true });
  const pids = [];
  t.after(async () => {
    for (const pid of pids) { try { process.kill(pid, 'SIGKILL'); } catch {} }
    await waitFor(() => pids.every(gone), 3000);
    await waitFor(() => { try { fs.rmSync(root, { recursive: true, force: true }); return true; } catch { return false; } }, 5000);
  });
  const script = path.join(root, 'linger.js');
  fs.writeFileSync(script, [
    "require('fs').writeFileSync(process.env.ACOLYTE_TEST_LOG + '.pid', String(process.pid));",
    "require('readline').createInterface({ input: process.stdin }).once('line', (line) => {",
    "  process.stdout.write(JSON.stringify({ id: JSON.parse(line).id, error: { message: 'the stand-in refuses' } }) + '\\n');",
    '});',
    "process.stdin.on('end', () => setTimeout(() => process.exit(0), 3000));",
    'setTimeout(() => process.exit(0), 30000);',
  ].join('\n') + '\n');
  const shim = path.join(root, 'codex.cmd');
  fs.writeFileSync(shim, `@echo off\r\n"${process.execPath}" "${script}" %*\r\n`);
  const preload = path.join(root, 'grace-preload.js');
  fs.writeFileSync(preload, `
if (process.argv.includes('--rpc-worker')) {
  const fs = require('fs');
  const cp = require('child_process');
  const log = (entry) => fs.appendFileSync(process.env.ACOLYTE_TEST_LOG, JSON.stringify({ at: Date.now(), ...entry }) + '\\n');
  const taskkill = (file) => /taskkill(\\.exe)?$/i.test(String(file));
  const { spawn, spawnSync, execFile } = cp;
  cp.spawnSync = function (file, args) {
    if (!taskkill(file)) return spawnSync.apply(this, arguments);
    log({ kill: 'spawnSync', args });
    return { status: 0, stdout: '', stderr: '', output: [] };
  };
  cp.execFile = function (file, args, ...rest) {
    if (!taskkill(file)) return execFile.apply(this, arguments);
    log({ kill: 'execFile', args });
    const done = rest.find((item) => typeof item === 'function');
    if (done) process.nextTick(done, null, '', '');
    return null;
  };
  cp.spawn = function (file, args) {
    const child = spawn.apply(this, arguments);
    if (!Array.isArray(args) || !args.some((arg) => String(arg).includes('app-server'))) return child;
    log({ event: 'spawn', pid: child.pid });
    child.once('exit', (code, signal) => log({ event: 'exit', code, signal }));
    child.once('close', () => log({ event: 'close' }));
    const end = child.stdin.end.bind(child.stdin);
    child.stdin.end = (...rest) => {
      const result = end(...rest);
      log({ event: 'finally' });
      if (process.env.ACOLYTE_TEST_SIGNAL_EXIT === '1') child.kill();
      return result;
    };
    return child;
  };
}
`);
  const worker = path.join(__dirname, '..', 'src', 'codex-mcp-config.js');
  const run = signalExit => new Promise(resolve => {
    const log = path.join(root, `${signalExit ? 'signal' : 'live'}.jsonl`);
    const child = spawn(process.execPath, ['--require', preload, worker, '--rpc-worker'], {
      env: { ...process.env, ACOLYTE_TEST_LOG: log, ACOLYTE_TEST_SIGNAL_EXIT: signalExit ? '1' : '' },
      stdio: ['pipe', 'pipe', 'ignore'], windowsHide: true });
    pids.push(child.pid);
    let output = '';
    let bounded = false;
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', chunk => { output += chunk; });
    // A run that never ends fails here, with its log, rather than holding the suite open.
    const bound = setTimeout(() => {
      bounded = true;
      try { require('node:child_process').execFileSync(path.join(process.env.SystemRoot, 'System32', 'taskkill.exe'), ['/PID', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch {}
    }, 30000);
    child.once('close', () => {
      clearTimeout(bound);
      if (fs.existsSync(`${log}.pid`)) pids.push(Number(fs.readFileSync(`${log}.pid`, 'utf8')));
      const entries = fs.existsSync(log) ? fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line)) : [];
      resolve({ output, entries, bounded });
    });
    // The deadline is only there to make the grace the read-only 1 s; the refusal comes first.
    child.stdin.end(JSON.stringify({ requests: [{ method: 'config/read', params: { cwd: null, includeLayers: true } }],
      home, codexHome, codexExecutable: shim, deadlineAt: Date.now() + 20000 }));
  });
  const at = (entries, event) => entries.find(entry => entry.event === event)?.at;

  const signal = await run(true);
  const said = `the worker said ${signal.output}; it logged ${JSON.stringify(signal.entries)}`;
  assert.equal(signal.bounded, false, `the worker did not finish within 30 s; ${said}`);
  assert.ok(at(signal.entries, 'spawn') && at(signal.entries, 'finally'), `precondition: the worker reached its finally; ${said}`);
  const exit = signal.entries.find(entry => entry.event === 'exit');
  assert.deepEqual([exit?.code, exit?.signal], [null, 'SIGTERM'], `precondition: the app-server exited by a signal; ${said}`);
  assert.ok(at(signal.entries, 'close') - at(signal.entries, 'finally') > 1300,
    `precondition: 'close' came after the 1 s grace, so the grace kill had to decide; ${said}`);
  // MUTATION: put the old grace kill back (`if (child.exitCode !== null) return;` and then
  // spawnSync(taskkillPath(), ['/PID', pid, '/T', '/F'])). It sends taskkill /T to the
  // signalled app-server's PID and this lists it. Confirmed 2026-10-14.
  assert.deepEqual(signal.entries.filter(entry => entry.kill), [],
    `a tree kill was aimed at an app-server that had already exited by a signal; ${said}`);
  assert.match(signal.output, /the stand-in refuses/, 'the finally came from the running stand-in\'s answer');

  // The control: a live app-server at the end of the grace gets the tree kill, so the
  // preload sees one when one is sent.
  const live = await run(false);
  assert.equal(live.bounded, false, `the control did not finish within 30 s; it logged ${JSON.stringify(live.entries)}`);
  const spawned = live.entries.find(entry => entry.event === 'spawn');
  assert.deepEqual(live.entries.filter(entry => entry.kill).map(entry => entry.args), [['/PID', String(spawned?.pid), '/T', '/F']],
    `the control: the live app-server got no tree kill; it logged ${JSON.stringify(live.entries)}`);
});
