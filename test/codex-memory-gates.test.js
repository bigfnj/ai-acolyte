'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../src/codex-memory-gates.js');
const sourceRequire = createRequire(filename);
const api = sourceRequire(filename);
const guidance = sourceRequire('./agent-guidance');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const globalGate = text => `---\nscope: global\n---\n<!-- gate -->\n${text}\n<!-- /gate -->\n`;
const NATIVE_BEGIN = '<!-- BEGIN permission-wildcarding: native Codex memory gates (managed) -->';
const NATIVE_END = '<!-- END permission-wildcarding: native Codex memory gates -->';
const shared = '<!-- BEGIN permission-wildcarding: memory gates (managed) -->\nShared rule\n<!-- END permission-wildcarding: memory gates -->\n';

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-gates-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const codexHome = path.join(home, 'selected'), root = path.join(codexHome, 'memories');
  const base = path.join(codexHome, 'AGENTS.md'), override = path.join(codexHome, 'AGENTS.override.md');
  fs.mkdirSync(root, { recursive: true });
  fs.mkdirSync(path.join(home, '.claude'));
  const claude = path.join(home, '.claude', 'CLAUDE.md');
  fs.writeFileSync(claude, 'Claude user text\n' + shared);
  fs.writeFileSync(base, 'Codex user text\n' + shared);
  const options = { home, codexHome };
  function write(relative, text) { const file = path.join(root, relative); fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text); return file; }
  return { home, codexHome, root, base, override, claude, options, write };
}
function mocked(overrides) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), { module, exports: module.exports, __dirname: path.dirname(filename), process, Buffer,
    require: name => overrides[name] || sourceRequire(name) }, { filename });
  return module.exports;
}

test('native gate compilation uses explicit global annotations on selected surfaces with exact source provenance', (t) => {
  const box = fixture(t);
  const files = [
    box.write('memory_summary.md', 'v1\n' + globalGate('- Summary rule.')),
    box.write('MEMORY.md', '\uFEFF\r\n' + globalGate('- Registry rule.').replace(/\n/g, '\r\n')),
    box.write('rollout_summaries/example.md', globalGate('- Rollout rule.').replace('scope: global', 'metadata:\n  scope: "global"')),
    box.write('skills/example/SKILL.md', globalGate('- Skill rule.')),
  ];
  box.write('raw_memories.md', globalGate('RAW MUST NOT COMPILE'));
  const status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.compilationState, 'ready');
  assert.equal(status.count, 4, 'WITNESS every selected native format can explicitly opt in');
  assert.equal(status.canEnable, true);
  assert.equal(status.body.includes('RAW MUST NOT COMPILE'), false);
  for (const gate of status.gates) {
    assert.ok(files.includes(gate.path));
    const bytes = fs.readFileSync(gate.path), text = bytes.toString('utf8');
    assert.equal(text.slice(gate.startOffset, gate.endOffset), gate.text);
    assert.equal(hash(bytes), gate.sourceHash);
    assert.equal(hash(gate.text), gate.bodyHash);
  }
  assert.equal(status.bodyHash, hash(status.body));
  assert.equal(fs.existsSync(status.compiledPath), false, 'inspection never writes a compiled cache');
});

test('remembered prose local scope YAML examples and fenced gate examples never become standing rules', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', '# Notes\nscope: global\n<!-- gate -->\nNot opted in.\n<!-- /gate -->\n');
  box.write('rollout_summaries/local.md', globalGate('Local must not compile').replace('scope: global', 'scope: project'));
  box.write('rollout_summaries/documented.md', '```yaml\n' + globalGate('Example must not compile') + '```\n');
  box.write('skills/example/SKILL.md', '---\nmetadata:\n  description: |\n    scope: global\n---\n<!-- gate -->\nDescription must not compile\n<!-- /gate -->\n');
  const fenced = globalGate('```markdown\n<!-- gate -->\nInner example\n<!-- /gate -->\n```');
  box.write('rollout_summaries/fenced.md', '---\nscope: global\n---\n```markdown\n<!-- gate -->\nNot a real gate\n<!-- /gate -->\n```\n');
  let status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.compilationState, 'zero');
  assert.equal(status.complete, true);
  assert.equal(status.count, 0);
  box.write('rollout_summaries/actual.md', fenced);
  status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.count, 1, 'a real outer gate can contain a fenced documentation example');
});

test('ambiguous scope and malformed global gate pairs block a partial compilation', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', globalGate('- Keep me.'));
  for (const text of [globalGate('- Bad.').replace('scope: global', 'scope: global\nscope: project'),
    globalGate('- Bad.').replace('<!-- /gate -->', ''), globalGate('<!-- gate -->\nNested'),
    '---\nscope: global\n---\n<!-- /gate -->\n']) {
    box.write('rollout_summaries/bad.md', text);
    const status = api.inspectNativeCodexGates(box.options);
    assert.equal(status.canEnable, false, 'WITNESS incomplete or ambiguous declarations cannot silently drop an installed rule');
    assert.equal(status.compilationState, 'unreadable');
    assert.ok(status.diagnostics.some(item => item.severity === 'error'));
    assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /cannot be enabled/);
  }
});

test('malformed scope scalars hold installed instructions while valid non-global scope deliberately clears the body', (t) => {
  const box = fixture(t);
  const initial = globalGate('- Keep this gate while its scope is malformed.');
  box.write('MEMORY.md', initial);
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  const installed = fs.readFileSync(box.base);
  for (const scope of ['"global', '[global', '{global', '"global" trailing', '', '*global', '|', '"g\\lobal"']) {
    box.write('MEMORY.md', initial.replace('scope: global', `scope: ${scope}`));
    const status = api.inspectNativeCodexGates(box.options);
    assert.equal(status.complete, false, `WITNESS malformed scalar holds installed gates: ${scope}`);
    assert.equal(status.compilationState, 'unreadable');
    assert.equal(status.canEnable, false);
    assert.ok(status.diagnostics.some(item => item.code === 'invalid-scope' && item.line === 2));
    assert.throws(() => api.refreshNativeCodexGates(box.options), /retained.*unreadable/);
    assert.deepEqual(fs.readFileSync(box.base), installed);
  }
  box.write('MEMORY.md', initial.replace('scope: global', 'scope:global'));
  assert.equal(api.inspectNativeCodexGates(box.options).complete, false, 'YAML mapping colon requires separation');
  assert.throws(() => api.refreshNativeCodexGates(box.options), /retained.*unreadable/);
  assert.deepEqual(fs.readFileSync(box.base), installed);
  box.write('MEMORY.md', initial.replace('scope: global', 'metadata:# malformed mapping\n  scope: global'));
  assert.equal(api.inspectNativeCodexGates(box.options).complete, false, 'metadata mapping also requires colon separation');
  assert.throws(() => api.refreshNativeCodexGates(box.options), /retained.*unreadable/);
  assert.deepEqual(fs.readFileSync(box.base), installed);
  for (const scope of ['project', 'task', "'project' # deliberate", 'global#project']) {
    box.write('MEMORY.md', initial.replace('scope: global', `scope: ${scope}`));
    const status = api.inspectNativeCodexGates(box.options);
    assert.equal(status.complete, true);
    assert.equal(status.compilationState, 'zero', 'a hash without preceding whitespace remains part of the scalar');
  }
  const result = api.refreshNativeCodexGates(box.options);
  assert.equal(result.on, true);
  assert.equal(result.count, 0);
  assert.equal(fs.readFileSync(box.base, 'utf8').includes('Keep this gate'), false);
});

test('comment-only metadata and separated scope comments preserve an explicit global annotation', (t) => {
  const box = fixture(t);
  const initial = globalGate('- Keep the explicit metadata gate.');
  box.write('MEMORY.md', initial);
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  const before = fs.readFileSync(box.base);
  for (const scope of ['global # global scope', "'global' # global scope", '"global" # global scope']) {
    box.write('MEMORY.md', initial.replace('scope: global', `metadata: # deliberate extension annotations\n  scope: ${scope}`));
    const status = api.inspectNativeCodexGates(box.options);
    assert.equal(status.complete, true);
    assert.equal(status.count, 1, 'WITNESS comment-only metadata still contains its explicit global scope');
    assert.equal(status.body.includes('Keep the explicit metadata gate'), true);
    api.refreshNativeCodexGates(box.options);
    assert.deepEqual(fs.readFileSync(box.base), before);
  }
});

test('install refresh and remove target only effective Codex instructions and preserve independent shared gates', (t) => {
  const box = fixture(t);
  fs.writeFileSync(box.override, 'Override user text\n' + shared);
  const originalBase = fs.readFileSync(box.base), originalOverride = fs.readFileSync(box.override), originalClaude = fs.readFileSync(box.claude);
  const file = box.write('MEMORY.md', globalGate('- Native rule one.'));
  const nativeBefore = fs.readFileSync(file);
  let status = api.inspectNativeCodexGates(box.options);
  const installed = api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options);
  assert.equal(installed.on, true);
  assert.equal(installed.path, box.override);
  assert.deepEqual(fs.readFileSync(box.base), originalBase);
  assert.deepEqual(fs.readFileSync(box.claude), originalClaude);
  assert.deepEqual(fs.readFileSync(file), nativeBefore);
  assert.ok(fs.readFileSync(box.override, 'utf8').includes(shared));
  status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.target.current, true);
  assert.equal(api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options).changed, false);
  box.write('MEMORY.md', globalGate('- Native rule two.'));
  status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.target.current, false);
  api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options);
  assert.match(fs.readFileSync(box.override, 'utf8'), /Native rule two/);
  const removed = api.setNativeCodexGates(false, { fingerprint: api.inspectNativeCodexGates(box.options).removalFingerprint }, box.options);
  assert.equal(removed.on, false);
  assert.deepEqual(fs.readFileSync(box.override), originalOverride);
  assert.deepEqual(fs.readFileSync(box.claude), originalClaude);
});

test('native block migration removes the inactive copy without replacing either user file or shared block', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Profile rule.'));
  const baseBefore = fs.readFileSync(box.base);
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  fs.writeFileSync(box.override, 'Later override\n' + shared);
  const status = api.inspectNativeCodexGates(box.options);
  assert.deepEqual(status.target.shadowedPaths, [box.base]);
  api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options);
  assert.deepEqual(fs.readFileSync(box.base), baseBefore);
  assert.equal(fs.readFileSync(box.override, 'utf8').includes(NATIVE_BEGIN), true);
});

test('complete zero absent and unreadable sources preserve installed gates until explicit source-independent removal', (t) => {
  const box = fixture(t); const file = box.write('MEMORY.md', globalGate('- Do not silently erase.'));
  let status = api.inspectNativeCodexGates(box.options);
  api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options);
  const installed = fs.readFileSync(box.base);
  box.write('MEMORY.md', '# No annotations\n');
  status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.compilationState, 'zero');
  assert.equal(status.target.on, true);
  assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /zero compilation/);
  fs.unlinkSync(file); fs.rmdirSync(box.root);
  status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.compilationState, 'absent');
  assert.deepEqual(fs.readFileSync(box.base), installed);
  fs.mkdirSync(box.root); fs.writeFileSync(path.join(box.root, 'MEMORY.md'), Buffer.from([0xc3, 0x28]));
  status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.compilationState, 'unreadable');
  // Even a missing compiled cache and a broken source adapter cannot stop removal.
  fs.unlinkSync(status.compiledPath); fs.mkdirSync(status.compiledPath);
  const independent = mocked({ './codex-memory': { readCodexMemory() { throw new Error('Source must not be read while disabling'); } } });
  assert.equal(independent.setNativeCodexGates(false, { fingerprint: status.removalFingerprint }, box.options).on, false);
  assert.equal(fs.readFileSync(box.base, 'utf8').includes(NATIVE_BEGIN), false);
  assert.equal(fs.readFileSync(box.base, 'utf8').includes(shared), true);
});

test('source bytes target bytes and newly active overrides invalidate a reviewed fingerprint', (t) => {
  const box = fixture(t); const file = box.write('MEMORY.md', globalGate('- Original.'));
  let status = api.inspectNativeCodexGates(box.options), stat = fs.statSync(file);
  fs.appendFileSync(file, '# Same gate, changed source bytes.\n');
  assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /review is stale/,
    'WITNESS review includes full source byte hashes, not only the compiled body');
  status = api.inspectNativeCodexGates(box.options);
  box.write('MEMORY.md', globalGate('- Modified.')); fs.utimesSync(file, stat.atime, stat.mtime);
  assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /review is stale/);
  status = api.inspectNativeCodexGates(box.options); fs.appendFileSync(box.base, 'Concurrent notes\n');
  assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /review is stale/);
  status = api.inspectNativeCodexGates(box.options); fs.writeFileSync(box.override, 'New effective override\n');
  assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /review is stale/);
  assert.equal(fs.existsSync(status.compiledPath), false);
});

test('source changes under the instruction locks and after compiled-cache writes are rechecked', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Before lock.'));
  const before = fs.readFileSync(box.base);
  let changed = false;
  const lockedApi = mocked({ './agent-guidance': { ...guidance,
    withInstructionLock(file, operation, busy) { return guidance.withInstructionLock(file, () => {
      if (!changed) { changed = true; box.write('MEMORY.md', globalGate('- During lock.')); }
      return operation();
    }, busy); } } });
  let status = api.inspectNativeCodexGates(box.options);
  assert.throws(() => lockedApi.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /while acquiring their locks/);
  status = api.inspectNativeCodexGates(box.options); changed = false;
  const writeApi = mocked({ fs: { ...fs, renameSync(from, to) {
    fs.renameSync(from, to);
    if (!changed && to === status.compiledPath) { changed = true; box.write('MEMORY.md', globalGate('- After cache.')); }
  } } });
  assert.throws(() => writeApi.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /sources or effective Codex target changed/);
  assert.deepEqual(fs.readFileSync(box.base), before);
  assert.equal(fs.existsSync(status.compiledPath), false);
});

test('strict rename failure rolls back earlier target changes and never falls back to an in-place write', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Original.'));
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  fs.writeFileSync(box.override, 'New override\n' + shared);
  box.write('MEMORY.md', globalGate('- Updated.'));
  const status = api.inspectNativeCodexGates(box.options);
  const before = new Map([box.base, box.override, status.compiledPath].map(file => [file, fs.readFileSync(file)]));
  const failing = mocked({ fs: { ...fs, renameSync(from, to) {
    if (to === box.base) throw Object.assign(new Error('injected rename failure'), { code: 'EIO' });
    return fs.renameSync(from, to);
  } } });
  assert.throws(() => failing.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /Previous instruction bytes were preserved/);
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readdirSync(box.codexHome).some(name => name.endsWith('.tmp')), false);
});

test('busy instruction lock linked targets and ambiguous native fences refuse changes visibly', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Rule.'));
  const status = api.inspectNativeCodexGates(box.options);
  const lock = sourceRequire('./policy-lock').createPolicyLock({ lockPath: guidance.instructionLockPath(box.override) });
  lock.locked(() => assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /being written/));
  fs.appendFileSync(box.base, NATIVE_BEGIN + '\nNo end marker\n');
  assert.match(api.inspectNativeCodexGates(box.options).target.error, /ambiguous/);
  assert.equal(fs.existsSync(status.compiledPath), false);
});

test('managed marker quotations in a source cannot become another feature writer fence', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', globalGate('- Keep literal examples:\n' + shared + NATIVE_BEGIN + '\n' + NATIVE_END));
  const status = api.inspectNativeCodexGates(box.options);
  assert.equal(status.body.includes('<!-- BEGIN permission-wildcarding:'), false);
  assert.match(status.body, /&lt;!-- BEGIN permission-wildcarding:/);
  api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options);
  const text = fs.readFileSync(box.base, 'utf8');
  assert.equal(text.split(NATIVE_BEGIN).length - 1, 1);
  assert.equal(text.split('<!-- BEGIN permission-wildcarding: memory gates (managed) -->').length - 1, 1);
});

test('automatic refresh requires installed opt-in and complete zero retains a sentinel until explicit Remove', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Opt in first.'));
  const original = fs.readFileSync(box.base);
  assert.equal(api.refreshNativeCodexGates(box.options).skipped, true);
  assert.deepEqual(fs.readFileSync(box.base), original);
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  box.write('MEMORY.md', globalGate('- Later annotation.'));
  assert.equal(api.refreshNativeCodexGates(box.options).on, true);
  assert.match(fs.readFileSync(box.base, 'utf8'), /Later annotation/);
  box.write('MEMORY.md', '# Complete corpus, no explicit gates.\n');
  const zero = api.refreshNativeCodexGates(box.options);
  assert.equal(zero.count, 0);
  assert.equal(zero.on, true, 'WITNESS complete zero retains the existing opt-in sentinel');
  assert.equal(api.inspectNativeCodexGates(box.options).target.current, true);
  assert.equal(fs.readFileSync(box.base, 'utf8').includes('Later annotation'), false);
  box.write('MEMORY.md', globalGate('- Recreated annotation.'));
  api.refreshNativeCodexGates(box.options);
  assert.match(fs.readFileSync(box.base, 'utf8'), /Recreated annotation/);
  const status = api.inspectNativeCodexGates(box.options);
  api.setNativeCodexGates(false, { fingerprint: status.removalFingerprint }, box.options);
  assert.equal(fs.existsSync(status.compiledPath), true, 'compiled history remains but is not an enable flag');
  assert.equal(api.refreshNativeCodexGates(box.options).skipped, true);
  assert.deepEqual(fs.readFileSync(box.base), original, 'WITNESS explicit Remove prevents automatic resurrection from cache');
});

test('automatic refresh holds installed text on absent unreadable or malformed sources', (t) => {
  const box = fixture(t); const file = box.write('MEMORY.md', globalGate('- Hold this rule.'));
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  const before = fs.readFileSync(box.base);
  fs.unlinkSync(file); fs.rmdirSync(box.root);
  assert.throws(() => api.refreshNativeCodexGates(box.options), /retained.*absent/);
  fs.mkdirSync(box.root); box.write('MEMORY.md', Buffer.from([0xc3, 0x28]));
  assert.throws(() => api.refreshNativeCodexGates(box.options), /retained.*unreadable/);
  box.write('MEMORY.md', globalGate('- Truncated.').replace('<!-- /gate -->', ''));
  assert.throws(() => api.refreshNativeCodexGates(box.options), /retained.*unreadable/);
  assert.deepEqual(fs.readFileSync(box.base), before);
});

test('automatic refresh cannot reinstall after an explicit removal races with instruction locking', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Initial.'));
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  box.write('MEMORY.md', globalGate('- Changed.'));
  let removed = false;
  const racing = mocked({ './agent-guidance': { ...guidance,
    withInstructionLock(file, operation, busy) {
      if (!removed) {
        removed = true;
        api.setNativeCodexGates(false, { fingerprint: api.inspectNativeCodexGates(box.options).removalFingerprint }, box.options);
      }
      return guidance.withInstructionLock(file, operation, busy);
    } } });
  assert.throws(() => racing.refreshNativeCodexGates(box.options), /while acquiring their locks/);
  assert.equal(api.inspectNativeCodexGates(box.options).target.on, false);
  assert.equal(fs.readFileSync(box.base, 'utf8').includes('Changed'), false);
});

test('linked instruction parents and private compiled parents are refused before any native gate write', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Keep paths ordinary.'));
  const before = fs.readFileSync(box.base), external = path.join(box.home, 'external-cache');
  fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(box.home, '.ai-acolyte'), process.platform === 'win32' ? 'junction' : 'dir');
  const status = api.inspectNativeCodexGates(box.options);
  assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /linked or not a directory/);
  assert.deepEqual(fs.readdirSync(external), []);
  assert.deepEqual(fs.readFileSync(box.base), before);
  const moved = path.join(box.home, 'moved-profile');
  fs.renameSync(box.codexHome, moved);
  fs.symlinkSync(moved, box.codexHome, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = api.inspectNativeCodexGates(box.options);
  assert.equal(linked.canEnable, false);
  assert.match(linked.target.error, /linked or not a directory/);
});

test('failed rollback preserves concurrent instruction edits and reports the remaining changed path', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Original.'));
  api.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
  fs.writeFileSync(box.override, 'New override\n');
  box.write('MEMORY.md', globalGate('- Updated.'));
  const status = api.inspectNativeCodexGates(box.options);
  let changed = false;
  const concurrent = mocked({ fs: { ...fs, renameSync(from, to) {
    fs.renameSync(from, to);
    if (!changed && to === box.override) { changed = true; fs.appendFileSync(box.override, 'Concurrent owner note\n'); }
  } } });
  assert.throws(() => concurrent.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), error => {
    assert.match(error.message, /Partial changes remain/);
    assert.equal(error.changedPaths.length, 1);
    assert.equal(error.changedPaths[0], box.override);
    return true;
  });
  assert.match(fs.readFileSync(box.override, 'utf8'), /Concurrent owner note/);
});
