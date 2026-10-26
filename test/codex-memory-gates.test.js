'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { removeDir } = require('./helpers/remove-dir');
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

// Fixture steps that a scanner can refuse for a moment, retried until it lets
// go; the same helper as test/codex-reviewed-plans.test.js, whose comment has
// the measurements. In short, on Windows (Node 24.19.0, 2026-10-13): renaming a
// directory fails EPERM while any file inside it is open, and junction creation
// fails EBUSY while anything has the new directory open. This file hit one
// EPERM in a full run while several worktrees ran the suite at once on the
// development box. Under the same stand-in scanner (60 runs, 6 in parallel),
// the "linked instruction parents" test failed on its profile-directory rename
// in 10 runs holding 10 ms and in 60 of 60 holding 100 ms. The rest of this
// file's failures were the PRODUCT's own swap, fixed in src/codex-memory-gates.js
// `strictWrite`. With both, 0 of 60 at either hold. Only EPERM, EACCES and
// EBUSY on Windows are retried, for ~2.6 s at most, and the original error is
// thrown after that.
const HELD = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RELEASE_WAITS_MS = [10, 20, 40, 80, 160, 320, 500, 500, 500, 500];
function whenReleased(operation) {
  for (let attempt = 0; ; attempt++) {
    try { return operation(attempt); } catch (error) {
      if (process.platform !== 'win32' || !HELD.has(error.code) || attempt >= RELEASE_WAITS_MS.length) throw error;
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, RELEASE_WAITS_MS[attempt]);
    }
  }
}
function linkDirectory(target, link) {
  whenReleased((attempt) => {
    // A failed junction can leave the empty directory libuv made; clear only that.
    if (attempt > 0 && fs.existsSync(link) && !fs.lstatSync(link).isSymbolicLink() && !fs.readdirSync(link).length) fs.rmdirSync(link);
    fs.symlinkSync(target, link, process.platform === 'win32' ? 'junction' : 'dir');
  });
}

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-native-gates-'));
  t.after(() => removeDir(home));
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
    // The scope is on the file's second line: 0-based line 1 since 2026-10-13, the
    // convention of the merged array (the merged-array test below says why).
    assert.ok(status.diagnostics.some(item => item.code === 'invalid-scope' && item.line === 1));
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

// inspectNativeCodexGates merges two producers into one `diagnostics` array: the
// selected-memory reader (src/codex-memory.js), whose `line` is 0-based because it is
// the VS Code Range line codexMemoryLint publishes, and this module's gate checks, which
// numbered from 1 until 2026-10-13. One array, two conventions: a consumer rendering the
// merged list would put every gate error one line low. Normalised to 0-based at the
// point gate diagnostics enter the array; a human-facing renderer adds 1, as
// vscode-extension/codexFeaturesUi.js Inspect already does for the reader's lines.
test('merged native-gate diagnostics share one line convention: 0-based, naming the offending line', (t) => {
  const box = fixture(t);
  const memory = '---\nscope: "global\n---\nSee rollout_summaries/missing.md for context.\n'
    + 'Earlier session: rollout_summaries/2026-10-26T09-18-00-Ab12-old_slug.md\n<!-- gate -->\n- x\n<!-- /gate -->\n';
  const files = {
    'MEMORY.md': memory,
    // The summary Codex renamed the cited one to (synthetic names). No frontmatter: no gate diagnostics.
    'rollout_summaries/2026-10-26T09-18-00-Ab12-new_slug.md': '# Synthetic rollout\n',
    'rollout_summaries/nested.md': '---\nscope: global\n---\nintro\n<!-- gate -->\na\n<!-- gate -->\nb\n<!-- /gate -->\n',
    'rollout_summaries/unpaired.md': '---\nscope: global\n---\nintro\n<!-- /gate -->\n',
    'rollout_summaries/unclosed.md': '---\nscope: global\nno closing fence\n',
    // CRLF must not change which line is named.
    'rollout_summaries/crlf.md': '---\r\nscope: [global\r\n---\r\n',
  };
  for (const [relative, text] of Object.entries(files)) box.write(relative, text);
  const status = api.inspectNativeCodexGates(box.options);
  // What each code must point at, as text on the 0-based line it names.
  const marker = {
    'missing-reference': 'rollout_summaries/missing.md', 'invalid-scope': 'scope:',
    'renamed-reference': 'rollout_summaries/2026-10-26T09-18-00-Ab12-old_slug.md',
    'nested-gate': '<!-- gate -->', 'unpaired-gate': '<!-- /gate -->', 'unclosed-frontmatter': '---',
  };
  const seen = new Set();
  for (const item of status.diagnostics) {
    if (item.line === undefined) continue; // storage failures carry no line
    seen.add(item.code);
    const lines = fs.readFileSync(item.path, 'utf8').split(/\r?\n/);
    assert.ok(Number.isSafeInteger(item.line) && item.line >= 0 && item.line < lines.length,
      `${item.code} line ${item.line} is a 0-based index into ${item.relativePath}`);
    // MUTATION: push `line` unchanged in gatesFromFile's warn (the old 1-based value).
    // invalid-scope then names the line after `scope:` and this fails. Confirmed 2026-10-13.
    assert.ok(lines[item.line].includes(marker[item.code]),
      `${item.code} in ${item.relativePath} names line ${item.line}: ${JSON.stringify(lines[item.line])}`);
  }
  // Both producers really are in the one array, or the check above proves nothing.
  assert.ok(seen.has('missing-reference'), 'the memory reader contributed a line-bearing diagnostic');
  assert.ok(seen.has('renamed-reference'), 'the memory reader contributed its renamed-reference diagnostic');
  for (const code of ['invalid-scope', 'nested-gate', 'unpaired-gate', 'unclosed-frontmatter']) {
    assert.ok(seen.has(code), `the gate checks contributed ${code}`);
  }
});

// A renamed-reference is a warning, and only an error holds the compilation, so a store whose
// MEMORY.md still cites a summary Codex renamed compiles its gates as before (2026-10-26). Its
// diagnostics are part of sourceSignature, so the fingerprint itself changes once on upgrade.
test('a renamed rollout-summary reference is a warning that leaves the native gate compilation complete', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', globalGate('- Renamed fixture rule.') + 'Earlier session: rollout_summaries/2026-10-26T09-18-00-Ab12-old_slug.md\n');
  box.write('rollout_summaries/2026-10-26T09-18-00-Ab12-new_slug.md', '# Synthetic rollout\n');
  const status = api.inspectNativeCodexGates(box.options);
  assert.deepEqual(status.diagnostics.map(item => [item.code, item.severity]), [['renamed-reference', 'warning']]);
  assert.equal(status.complete, true, 'WITNESS a warning does not block the compilation');
  assert.equal(status.compilationState, 'ready');
  assert.equal(status.count, 1);
  assert.equal(status.canEnable, true);
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
  let baseRenames = 0;
  const failing = mocked({ fs: { ...fs, renameSync(from, to) {
    if (to === box.base) { baseRenames++; throw Object.assign(new Error('injected rename failure'), { code: 'EIO' }); }
    return fs.renameSync(from, to);
  } } });
  assert.throws(() => failing.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /Previous instruction bytes were preserved/);
  assert.equal(baseRenames, 1, 'WITNESS an error no holder produces is not retried');
  for (const [file, bytes] of before) assert.deepEqual(fs.readFileSync(file), bytes);
  assert.equal(fs.readdirSync(box.codexHome).some(name => name.endsWith('.tmp')), false);
});

// A momentary holder -- Defender, the indexer, Codex itself reading AGENTS.md --
// makes the Windows swap fail EPERM, EBUSY or EACCES and then lets go. Until
// 2026-10-13 the strict writer failed the whole update on the first refusal
// (41 of 60 parallel runs of this file under a stand-in scanner holding each
// new file for 10 ms). The refusals are injected here, so this runs the same on
// every platform. `holder` counts the renames aimed at the instruction target.
function holder(box, refusals, code) {
  let calls = 0;
  const gates = mocked({ fs: { ...fs, renameSync(from, to) {
    if (to === box.base && ++calls <= refusals) throw Object.assign(new Error(`injected ${code} holder`), { code });
    return fs.renameSync(from, to);
  } } });
  return { gates, calls: () => calls };
}
const leftovers = box => fs.readdirSync(box.codexHome).filter(name => name.endsWith('.tmp'));

test('a momentarily held instruction target is retried until the same atomic rename lands', (t) => {
  for (const [code, refusals] of [['EPERM', 3], ['EBUSY', 1], ['EACCES', 1]]) {
    const box = fixture(t); box.write('MEMORY.md', globalGate('- Held rule.'));
    const flaky = holder(box, refusals, code);
    const result = flaky.gates.setNativeCodexGates(true, { fingerprint: api.inspectNativeCodexGates(box.options).fingerprint }, box.options);
    assert.equal(result.on, true, `WITNESS ${code} from a holder that lets go does not fail the update`);
    // At least, not exactly: a real scanner on the box can refuse an attempt of
    // its own on top of the injected ones (46 of 60 stressed runs did, when this
    // said `=== refusals + 1`). The bound itself is the persistent-holder test's.
    assert.ok(flaky.calls() > refusals, 'the same rename, repeated past every injected refusal, is what landed');
    const text = fs.readFileSync(box.base, 'utf8');
    assert.match(text, /Held rule/);
    assert.equal(text.startsWith('Codex user text\n' + shared), true, 'user text and the shared block are untouched');
    assert.deepEqual(leftovers(box), []);
  }
});

test('a persistent holder still fails after a bounded retry, with every earlier byte restored', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Never lands.'));
  const status = api.inspectNativeCodexGates(box.options);
  const original = fs.readFileSync(box.base);
  const stuck = holder(box, Infinity, 'EPERM');
  assert.throws(() => stuck.gates.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options),
    /EPERM.*Previous instruction bytes were preserved/);
  assert.equal(stuck.calls(), 10, 'WITNESS the retry is bounded (ten attempts, 0.9 s of waits)');
  assert.deepEqual(fs.readFileSync(box.base), original, 'WITNESS no in-place write after the retries run out');
  assert.equal(fs.existsSync(status.compiledPath), false, 'the compiled cache written before the target is rolled back');
  assert.deepEqual(leftovers(box), []);
});

// The holder may be a WRITER: someone saving AGENTS.md holds it open, and a
// rename that waited them out would land over their edit. The retry re-reads
// the target before every attempt and stops when it changed.
test('a retried rename never outwaits a writer: bytes changed during the wait stop the write and are kept', (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Must not clobber.'));
  const status = api.inspectNativeCodexGates(box.options);
  let calls = 0;
  const racing = mocked({ fs: { ...fs, renameSync(from, to) {
    if (to === box.base && ++calls === 1) {
      fs.appendFileSync(box.base, 'Saved by the owner mid-write\n');
      throw Object.assign(new Error('injected writer hold'), { code: 'EPERM' });
    }
    return fs.renameSync(from, to);
  } } });
  assert.throws(() => racing.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options),
    /changed while its rename was retried \(EPERM\).*Previous instruction bytes were preserved/);
  assert.equal(calls, 1, 'WITNESS no rename is attempted over bytes that changed');
  const text = fs.readFileSync(box.base, 'utf8');
  assert.match(text, /Saved by the owner mid-write/);
  assert.equal(text.includes(NATIVE_BEGIN), false, 'WITNESS the owner\'s bytes are kept, not replaced');
  assert.deepEqual(leftovers(box), []);
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
  linkDirectory(external, path.join(box.home, '.ai-acolyte'));
  const status = api.inspectNativeCodexGates(box.options);
  assert.throws(() => api.setNativeCodexGates(true, { fingerprint: status.fingerprint }, box.options), /linked or not a directory/);
  assert.deepEqual(fs.readdirSync(external), []);
  assert.deepEqual(fs.readFileSync(box.base), before);
  const moved = path.join(box.home, 'moved-profile');
  whenReleased(() => fs.renameSync(box.codexHome, moved));
  linkDirectory(moved, box.codexHome);
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

// Codex's consolidation job status rides on the worker's codexMemory report only
// (src/auto-learn-worker.js), never on readCodexMemory, which this reads. A status that
// changes on every hourly retry must not move the signature that the gate fingerprint
// and the automatic refresh are keyed on (2026-10-26, src/codex-consolidation.js).
// MUTATION (by construction, not run: it would edit src/codex-memory.js): push
// readCodexConsolidation's diagnostics into readCodexMemory's result. The signature then
// moves and the warning appears here, and this fails.
let gatesSqlite = null;
try { gatesSqlite = require('node:sqlite'); } catch { gatesSqlite = null; }
const GatesDatabase = gatesSqlite && (typeof gatesSqlite.Database === 'function' ? gatesSqlite.Database : gatesSqlite.DatabaseSync);
if (typeof GatesDatabase !== 'function') {
  process.stderr.write(`\n[codex-memory-gates] SKIPPING the consolidation test: node:sqlite is unavailable on ${process.version}.\n\n`);
}
test('native gates never see consolidation status', { skip: typeof GatesDatabase !== 'function' }, (t) => {
  const box = fixture(t); box.write('MEMORY.md', globalGate('- Keep the signature still.'));
  const before = api.inspectNativeCodexGates(box.options);
  const db = new GatesDatabase(path.join(box.codexHome, 'memories_1.sqlite'));
  db.exec('CREATE TABLE jobs (kind TEXT, job_key TEXT, status TEXT, finished_at INTEGER, retry_at INTEGER, retry_remaining INTEGER, last_error TEXT)');
  db.prepare('INSERT INTO jobs VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run('memory_consolidate_global', 'global', 'error', 1792999080, 1793002680, 2, 'failed_workspace_commit');
  db.close();
  const after = api.inspectNativeCodexGates(box.options);
  assert.equal(after.sourceSignature, before.sourceSignature);
  assert.equal(after.fingerprint, before.fingerprint);
  assert.equal(after.diagnostics.some(item => item.code === 'consolidation-failed'), false);
  // Witness: the same home through the worker does carry the warning, so the store is real.
  const { run } = require('../src/auto-learn-worker');
  const report = run({ operation: 'codexMemory', options: { ...box.options, run: () => { throw new Error('spawned'); } }, args: [{}] });
  assert.equal(report.diagnostics.filter(item => item.code === 'consolidation-failed').length, 1);
});
