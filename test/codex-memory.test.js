'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { discoverCodexMemory, readCodexMemory, queryCodexMemory } = require('../src/codex-memory');

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-native-memory-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const home = path.join(root, 'user');
  const codexHome = path.join(root, 'custom-codex');
  const memory = path.join(codexHome, 'memories');
  fs.mkdirSync(home);
  function write(relativePath, content) {
    const target = path.join(memory, ...relativePath.split('/'));
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
    return target;
  }
  return { root, home, codexHome, memory, write };
}

function hash(value) { return crypto.createHash('sha256').update(value).digest('hex'); }

function mockError(t, method, exactPath, code) {
  const original = fs[method];
  t.mock.method(fs, method, function (file, ...args) {
    if (path.resolve(String(file)) === path.resolve(exactPath)) {
      throw Object.assign(new Error('synthetic access failure'), { code });
    }
    return original.call(this, file, ...args);
  });
}

test('native memory discovery follows custom home while explicit home stays isolated from ambient CODEX_HOME', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', '# Custom registry\n');
  const defaultMemory = path.join(box.home, '.codex', 'memories');
  fs.mkdirSync(defaultMemory, { recursive: true });
  fs.writeFileSync(path.join(defaultMemory, 'memory_summary.md'), 'v1\nDefault summary\n');
  const previous = process.env.CODEX_HOME;
  process.env.CODEX_HOME = box.codexHome;
  t.after(() => { if (previous === undefined) delete process.env.CODEX_HOME; else process.env.CODEX_HOME = previous; });

  assert.equal(discoverCodexMemory().codexHome, box.codexHome);
  const explicitHome = discoverCodexMemory({ home: box.home });
  assert.equal(explicitHome.codexHome, path.join(box.home, '.codex'));
  assert.deepEqual(explicitHome.files.map((file) => file.relativePath), ['memory_summary.md']);
  const custom = discoverCodexMemory({ home: box.home, codexHome: box.codexHome });
  assert.deepEqual(custom.files.map((file) => file.relativePath), ['MEMORY.md']);
  assert.equal(custom.featureState, 'unknown');
});

test('native memory states distinguish absent, disabled with retained files, empty readable and unreadable', (t) => {
  const box = fixture(t);
  const absent = discoverCodexMemory({ codexHome: box.codexHome });
  assert.equal(absent.state, 'absent');
  assert.equal(absent.storageState, 'absent');
  assert.equal(absent.featureState, 'unknown');
  assert.equal(fs.existsSync(box.codexHome), false, 'discovery must not create native storage');
  fs.mkdirSync(box.memory, { recursive: true });
  const empty = discoverCodexMemory({ codexHome: box.codexHome, featureState: 'enabled' });
  assert.equal(empty.state, 'readable');
  assert.deepEqual(empty.files, []);
  box.write('MEMORY.md', '# Retained registry\n');
  const disabled = readCodexMemory({ codexHome: box.codexHome, featureState: 'disabled' });
  assert.equal(disabled.state, 'disabled');
  assert.equal(disabled.storageState, 'readable');
  assert.equal(disabled.files[0].readable, true, 'retained files remain inspectable without claiming feature use');
  mockError(t, 'readdirSync', box.memory, 'EACCES');
  const unreadable = discoverCodexMemory({ codexHome: box.codexHome });
  assert.equal(unreadable.state, 'unreadable');
  assert.equal(unreadable.partial, false);
  assert.equal(unreadable.diagnostics[0].code, 'root-unreadable');
  assert.match(unreadable.diagnostics[0].message, /EACCES/);
});

test('native memory does not infer effective enablement from config text', (t) => {
  const box = fixture(t);
  box.write('memory_summary.md', 'v1\nSynthetic summary\n');
  fs.writeFileSync(path.join(box.codexHome, 'config.toml'), '[features]\nmemories = true\n[memories]\nuse_memories = false\n');
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (file, ...args) {
    assert.notEqual(path.basename(String(file)), 'config.toml', 'adapter must not guess layered feature state');
    return original.call(this, file, ...args);
  });
  assert.equal(readCodexMemory({ codexHome: box.codexHome }).featureState, 'unknown');
  assert.throws(() => discoverCodexMemory({ codexHome: box.codexHome, featureState: true }), /featureState/);
});

test('native selected surfaces include registry, immediate rollouts and one-level skills while excluding raw and private inputs', (t) => {
  const box = fixture(t);
  const selected = [
    ['MEMORY.md', 'registry'], ['memory_summary.md', 'summary'],
    ['rollout_summaries/query.md', 'rollout-summary'], ['skills/query/SKILL.md', 'skill'],
  ];
  for (const [relativePath] of selected) box.write(relativePath, relativePath === 'memory_summary.md' ? 'v1\nSelected witness\n' : '# Selected witness\n');
  for (const relativePath of [
    'raw_memories.md', 'phase2_workspace_diff.md', 'other.md', 'memories_1.sqlite',
    '.git/private.md', 'sessions/rollout.md', 'rollout_summaries/nested/private.md',
    'rollout_summaries/private.jsonl', 'skills/query/private.md', 'skills/query/scripts/private.md',
    'skills/SKILL.md', 'skills/nested/query/SKILL.md', 'extensions/private.md', 'tmp/private.md',
  ]) box.write(relativePath, 'FORBIDDEN_RAW_FIXTURE\n');
  const corpus = readCodexMemory({ codexHome: box.codexHome });
  assert.deepEqual(corpus.files.map((file) => [file.relativePath, file.kind]), selected);
  assert.equal(corpus.storageState, 'readable');
  assert.equal(corpus.chunks.some((chunk) => chunk.text.includes('FORBIDDEN_RAW_FIXTURE')), false);
  assert.deepEqual(queryCodexMemory(corpus, 'FORBIDDEN_RAW_FIXTURE'), []);
});

test('metadata discovery does not read selected native content', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', '# No content read\n');
  t.mock.method(fs, 'readFileSync', () => { throw new Error('metadata discovery read content'); });
  const result = discoverCodexMemory({ codexHome: box.codexHome });
  assert.equal(result.files.length, 1);
  assert.equal(result.files[0].size, Buffer.byteLength('# No content read\n'));
  assert.equal(result.files[0].sha256, undefined);
});

test('unreadable selected files report partial corpus and never masquerade as empty success', (t) => {
  const box = fixture(t);
  const failed = box.write('MEMORY.md', '# Unreadable fixture\n');
  box.write('memory_summary.md', 'v1\nReadable fixture\n');
  mockError(t, 'readFileSync', failed, 'EACCES');
  const result = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(result.state, 'unreadable');
  assert.equal(result.partial, true);
  assert.equal(result.files.find((file) => file.relativePath === 'MEMORY.md').readable, false);
  assert.deepEqual(result.chunks.map((chunk) => chunk.relativePath), ['memory_summary.md']);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'file-unreadable' && diagnostic.path === failed));
});

test('invalid UTF-8 is diagnosed without replacement-character indexing or source writes', (t) => {
  const box = fixture(t);
  const bytes = Buffer.from([35, 32, 0xC3, 0x28, 10]);
  const file = box.write('MEMORY.md', bytes);
  const result = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(result.state, 'unreadable');
  assert.equal(result.files[0].readable, false);
  assert.deepEqual(result.chunks, []);
  assert.equal(result.partial, false);
  assert.equal(result.diagnostics[0].code, 'invalid-utf8');
  assert.deepEqual(fs.readFileSync(file), bytes);
});

test('bounded native reads surface limits and changing-file failures', (t) => {
  const box = fixture(t);
  const file = box.write('MEMORY.md', '# Bounded fixture\n');
  const limited = readCodexMemory({ codexHome: box.codexHome, maxFileBytes: 4 });
  assert.equal(limited.state, 'unreadable');
  assert.equal(limited.diagnostics[0].code, 'file-too-large');
  assert.deepEqual(limited.chunks, []);
  const original = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    const bytes = original.call(this, target, ...args);
    if (target === file) fs.appendFileSync(file, 'changed\n');
    return bytes;
  });
  const changed = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(changed.state, 'unreadable');
  assert.ok(changed.diagnostics.some((diagnostic) => diagnostic.code === 'file-changed'));
  assert.deepEqual(changed.chunks, []);
});

test('linked native roots and selected linked subdirectories are not followed', (t) => {
  const box = fixture(t);
  const external = path.join(box.root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'MEMORY.md'), 'EXTERNAL_PRIVATE_FIXTURE\n');
  fs.mkdirSync(box.codexHome);
  fs.symlinkSync(external, box.memory, process.platform === 'win32' ? 'junction' : 'dir');
  const root = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(root.state, 'unreadable');
  assert.equal(root.diagnostics[0].code, 'root-unreadable');
  assert.deepEqual(root.chunks, []);
  fs.unlinkSync(box.memory);
  fs.mkdirSync(box.memory);
  fs.symlinkSync(external, path.join(box.memory, 'rollout_summaries'), process.platform === 'win32' ? 'junction' : 'dir');
  const child = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(child.state, 'unreadable');
  assert.ok(child.diagnostics.some((diagnostic) => diagnostic.code === 'linked-path' && diagnostic.relativePath === 'rollout_summaries'));
  assert.deepEqual(child.chunks, []);
});

test('a selected parent replaced by a link after discovery is rejected before content read', (t) => {
  const box = fixture(t);
  box.write('rollout_summaries/fixture.md', '# Native selected witness\n');
  const external = path.join(box.root, 'external');
  fs.mkdirSync(external);
  fs.writeFileSync(path.join(external, 'fixture.md'), 'EXTERNAL_PRIVATE_FIXTURE\n');
  const originalStat = fs.lstatSync;
  let selectedStats = 0;
  t.mock.method(fs, 'lstatSync', function (target, ...args) {
    const stat = originalStat.call(this, target, ...args);
    if (path.resolve(String(target)) === path.join(box.memory, 'rollout_summaries', 'fixture.md') && ++selectedStats === 1) {
      fs.renameSync(path.join(box.memory, 'rollout_summaries'), path.join(box.memory, 'original-rollouts'));
      fs.symlinkSync(external, path.join(box.memory, 'rollout_summaries'), process.platform === 'win32' ? 'junction' : 'dir');
    }
    return stat;
  });
  const originalRead = fs.readFileSync;
  t.mock.method(fs, 'readFileSync', function (target, ...args) {
    assert.ok(!String(target).includes('rollout_summaries'), 'replaced parent must be rejected before any content read');
    return originalRead.call(this, target, ...args);
  });
  const result = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(result.state, 'unreadable');
  assert.equal(result.partial, false);
  assert.deepEqual(result.chunks, []);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'linked-or-invalid-parent'));
});

test('a selected file disappearing after discovery reports unreadable rather than empty success', (t) => {
  const box = fixture(t);
  const file = box.write('MEMORY.md', '# Temporary selected fixture\n');
  const originalStat = fs.lstatSync;
  let selectedStats = 0;
  t.mock.method(fs, 'lstatSync', function (target, ...args) {
    const stat = originalStat.call(this, target, ...args);
    if (target === file && ++selectedStats === 1) fs.unlinkSync(file);
    return stat;
  });
  const result = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(result.state, 'unreadable');
  assert.equal(result.partial, false);
  assert.deepEqual(result.chunks, []);
  assert.ok(result.diagnostics.some((diagnostic) => diagnostic.code === 'file-changed'));
});

test('Codex registry has no Claude 200-line truncation and chunks preserve every exact CRLF byte', (t) => {
  const box = fixture(t);
  const body = '# Task Group: synthetic\r\n' + Array.from({ length: 240 }, (_, index) => `line ${index + 1} fixture`).join('\r\n') + '\r\n';
  const file = box.write('MEMORY.md', body);
  const before = fs.readFileSync(file);
  const result = readCodexMemory({ codexHome: box.codexHome, maxChars: 100, maxLines: 3 });
  assert.equal(result.files[0].lineCount, 241);
  assert.equal(result.lineCount, 241);
  assert.equal(result.files[0].sha256, hash(before));
  assert.equal(result.chunks.map((chunk) => chunk.text).join(''), body);
  assert.equal(result.chunks.at(-1).endLine, 241);
  for (const chunk of result.chunks) {
    assert.equal(chunk.text, body.slice(chunk.startOffset, chunk.endOffset));
    assert.equal(chunk.sha256, hash(Buffer.from(chunk.text)));
    assert.ok(chunk.text.length <= 100);
    assert.ok(chunk.endLine - chunk.startLine < 3);
  }
  assert.deepEqual(result.diagnostics, []);
  assert.deepEqual(fs.readFileSync(file), before, 'read/chunk/lint must preserve native bytes');
});

test('registry task sections remain independent while fenced headings do not split them', (t) => {
  const box = fixture(t);
  const body = '# Task Group: fixture\n## Task 1: plumbing\n### keywords\npipe witness\n```md\n## Not a task\n```\n## Task 2: widgets\n### keywords\nwidget witness\n';
  box.write('MEMORY.md', body);
  const result = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(result.chunks.length, 3);
  assert.equal(result.chunks[1].title, 'Task Group: fixture / Task 1: plumbing');
  assert.match(result.chunks[1].text, /## Not a task/);
  assert.match(result.chunks[1].text, /### keywords/);
  assert.equal(result.chunks[2].title, 'Task Group: fixture / Task 2: widgets');
  assert.equal(result.chunks[2].startLine, 8);
  assert.equal(result.chunks.map((chunk) => chunk.text).join(''), body);
});

test('oversized lines retain exact provenance and do not split surrogate pairs or CRLF', (t) => {
  const box = fixture(t);
  const body = '\uFEFFprefix😀suffix😀\r\nsecond\n';
  box.write('MEMORY.md', body);
  const result = readCodexMemory({ codexHome: box.codexHome, maxChars: 2, maxLines: 1 });
  assert.equal(result.chunks.map((chunk) => chunk.text).join(''), body);
  for (const chunk of result.chunks) {
    assert.ok(chunk.text.length <= 2);
    assert.equal(chunk.text, body.slice(chunk.startOffset, chunk.endOffset));
    assert.equal(Buffer.from(chunk.text).toString('utf8'), chunk.text);
    assert.equal(chunk.text.endsWith('\r'), false);
    assert.equal(chunk.startLine, chunk.endLine);
    const lineStart = chunk.startLine === 1 ? 0 : body.indexOf('\n') + 1;
    assert.equal(chunk.startColumn, chunk.startOffset - lineStart + 1);
    assert.equal(chunk.endColumn, chunk.endOffset - lineStart + 1);
  }
});

test('summary lint reports native schema marker without applying a Claude line cap', (t) => {
  const box = fixture(t);
  const file = box.write('memory_summary.md', 'not-v1\n' + 'summary fixture\n'.repeat(220));
  const invalid = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(invalid.state, 'readable');
  assert.equal(invalid.files[0].lineCount, 221);
  assert.deepEqual(invalid.diagnostics.map((diagnostic) => diagnostic.code), ['summary-version']);
  fs.writeFileSync(file, 'v1\n' + 'summary fixture\n'.repeat(220));
  assert.deepEqual(readCodexMemory({ codexHome: box.codexHome }).diagnostics, []);
});

test('explicit UTF-8 BOM provenance accompanies every chunk while native text and offsets remain exact', (t) => {
  const box = fixture(t);
  const body = '\uFEFF# Task Group: BOM fixture\r\nfirst passage\r\n## Task 2: later\r\nlater passage\r\n';
  const file = box.write('MEMORY.md', body);
  const withBom = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(withBom.files[0].hasUtf8Bom, true);
  assert.equal(withBom.files[0].sha256, hash(Buffer.from(body)));
  assert.equal(withBom.chunks.length, 2);
  assert.equal(withBom.chunks[0].title, 'Task Group: BOM fixture');
  assert.equal(withBom.chunks[0].text[0], '\uFEFF');
  assert.equal(withBom.chunks[0].startOffset, 0);
  assert.equal(withBom.chunks[1].startOffset, body.indexOf('## Task 2'));
  for (const chunk of withBom.chunks) {
    assert.equal(chunk.hasUtf8Bom, true, 'later passages also need the explicit document offset adjustment');
    assert.equal(chunk.text, body.slice(chunk.startOffset, chunk.endOffset));
  }
  assert.deepEqual(fs.readFileSync(file), Buffer.from(body));
  fs.writeFileSync(file, body.slice(1));
  const plain = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(plain.files[0].hasUtf8Bom, false);
  assert.ok(plain.chunks.every((chunk) => chunk.hasUtf8Bom === false));
  assert.equal(plain.chunks[1].startOffset, withBom.chunks[1].startOffset - 1);
});

test('native provenance lint checks only selected local references and never reads original rollout paths', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', '# Task Group\n## Task 1\n### rollout_summary_files\n- rollout_summaries/found.md\n- rollout_summaries/missing.md\n- skills/found/SKILL.md\n- skills/missing/SKILL.md\nrollout_path: C:/private/original-session.jsonl\n');
  box.write('rollout_summaries/found.md', '# Synthetic rollout\n');
  box.write('skills/found/SKILL.md', '# Synthetic skill\n');
  const result = readCodexMemory({ codexHome: box.codexHome });
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['missing-reference', 'missing-reference']);
  assert.match(result.diagnostics[0].message, /rollout_summaries\/missing.md/);
  assert.match(result.diagnostics[1].message, /skills\/missing\/SKILL.md/);
  assert.ok(result.diagnostics.every((diagnostic) => !diagnostic.message.includes('private')));
});

test('traversing native provenance references are diagnosed and never opened', (t) => {
  const box = fixture(t);
  box.write('MEMORY.md', '# Task Group\nrollout_summaries/../raw_memories.md\nskills/../SKILL.md\n');
  box.write('raw_memories.md', 'RAW_PRIVATE_FIXTURE\n');
  const result = readCodexMemory({ codexHome: box.codexHome });
  assert.deepEqual(result.diagnostics.map((diagnostic) => diagnostic.code), ['unsafe-reference', 'unsafe-reference']);
  assert.equal(result.chunks.some((chunk) => chunk.text.includes('RAW_PRIVATE_FIXTURE')), false);
});

test('chunk identity distinguishes same-name sources and changes with edits, ranges, renames and profile', (t) => {
  const box = fixture(t);
  const file = box.write('rollout_summaries/shared.md', '# First\nsame content\n');
  box.write('skills/shared/SKILL.md', '# First\nsame content\n');
  const first = readCodexMemory({ codexHome: box.codexHome });
  assert.notEqual(first.chunks[0].sourceId, first.chunks[1].sourceId);
  assert.notEqual(first.chunks[0].id, first.chunks[1].id);
  assert.equal(first.chunks[0].sha256, first.chunks[1].sha256);
  fs.writeFileSync(file, '# First\nchanged content\n');
  const edited = readCodexMemory({ codexHome: box.codexHome });
  assert.equal(edited.chunks[0].sourceId, first.chunks[0].sourceId);
  assert.notEqual(edited.chunks[0].id, first.chunks[0].id);
  assert.notEqual(edited.files[0].sha256, first.files[0].sha256);
  fs.renameSync(file, path.join(path.dirname(file), 'renamed.md'));
  const renamed = readCodexMemory({ codexHome: box.codexHome });
  assert.notEqual(renamed.chunks[0].sourceId, edited.chunks[0].sourceId);
  const ranged = readCodexMemory({ codexHome: box.codexHome, maxChars: 5 });
  assert.notEqual(ranged.chunks[0].id, renamed.chunks[0].id);
  const secondHome = path.join(box.root, 'second-codex');
  fs.cpSync(box.memory, path.join(secondHome, 'memories'), { recursive: true });
  assert.notEqual(readCodexMemory({ codexHome: secondHome }).chunks[0].sourceId, renamed.chunks[0].sourceId);
  fs.unlinkSync(path.join(path.dirname(file), 'renamed.md'));
  assert.equal(readCodexMemory({ codexHome: box.codexHome }).files.length, 1);
});

test('lexical query ranks relevant native sections and returns deterministic exact source provenance without writes', (t) => {
  const box = fixture(t);
  const registry = box.write('MEMORY.md', '# Task Group\n## Task 1: oranges\ncitrus orchard harvest\n## Task 2: compiler\ncompiler parser syntax compiler\n');
  box.write('rollout_summaries/other.md', '# Other\nparser fixture only\n');
  const bytes = fs.readFileSync(registry);
  const corpus = readCodexMemory({ codexHome: box.codexHome });
  const hits = queryCodexMemory(corpus, 'COMPILER parser', { limit: 2 });
  assert.equal(hits.length, 2);
  assert.equal(hits[0].relativePath, 'MEMORY.md');
  assert.equal(hits[0].title, 'Task Group / Task 2: compiler');
  assert.equal(hits[0].startLine, 4);
  assert.ok(hits[0].score > hits[1].score);
  assert.equal(hits[0].sha256, hash(Buffer.from(hits[0].text)));
  assert.equal(hits[0].text, bytes.toString('utf8').slice(hits[0].startOffset, hits[0].endOffset));
  assert.deepEqual(queryCodexMemory(corpus, 'COMPILER parser', { limit: 2 }), hits);
  assert.deepEqual(queryCodexMemory(corpus, 'unmatched'), []);
  assert.deepEqual(queryCodexMemory(corpus, '?!'), []);
  assert.deepEqual(queryCodexMemory({ chunks: [] }, 'compiler'), []);
  assert.deepEqual(fs.readFileSync(registry), bytes);
  assert.deepEqual(fs.readdirSync(box.memory).sort(), ['MEMORY.md', 'rollout_summaries']);
});

test('query token normalization handles Unicode and ties use stable provenance order', (t) => {
  const box = fixture(t);
  box.write('rollout_summaries/z.md', 'Ｆｉｘｔｕｒｅ café 日本語\n');
  box.write('rollout_summaries/a.md', 'Ｆｉｘｔｕｒｅ café 日本語\n');
  const corpus = readCodexMemory({ codexHome: box.codexHome });
  const hits = queryCodexMemory(corpus, 'fixture CAFÉ 日本語');
  assert.deepEqual(hits.map((hit) => hit.relativePath), ['rollout_summaries/a.md', 'rollout_summaries/z.md']);
  assert.equal(hits[0].score, hits[1].score);
  assert.equal(queryCodexMemory(corpus, 'fixture', { limit: 1 }).length, 1);
});

test('native memory option bounds reject invalid requests rather than silently disabling checks', (t) => {
  const box = fixture(t);
  for (const options of [{ maxChars: 1 }, { maxChars: NaN }, { maxLines: 0 }, { maxFileBytes: -1 }]) {
    assert.throws(() => readCodexMemory({ codexHome: box.codexHome, ...options }), /must be an integer/);
  }
  assert.throws(() => queryCodexMemory({ chunks: [] }, 'test', { limit: 0 }), /limit/);
});
