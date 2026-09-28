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
