#!/usr/bin/env node
'use strict';

// Actual CPU model acceptance over synthetic, private temporary fixtures. No
// Codex turn, model generation, GPU, download or live memory/profile access.
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const assert = require('assert/strict');
const { spawnSync } = require('child_process');
const args = process.argv.slice(2);
function argument(name, fallback) {
  const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1];
}
const subject = argument('--extension-dir');
if (!subject || !path.isAbsolute(subject)) throw new Error('--extension-dir must name an explicit absolute source or staged extension directory');
const extensionDir = path.resolve(subject);
const selectedCase = argument('--case', 'all');
if (!['all', 'paraphrases', 'windows', 'cache', 'profiles', 'foreign-cache', 'fallback'].includes(selectedCase)) throw new Error('Unknown focused runtime case');
const sha = data => crypto.createHash('sha256').update(data).digest('hex');
const names = ['src/codex-recall.js', 'src/codex-memory.js', 'src/codex-paths.js', 'memory/codex_recall.py', 'memory/recall.py'];
const hashes = Object.fromEntries(names.map(name => [name, sha(fs.readFileSync(path.join(extensionDir, name)))]));
let manifest;
try { manifest = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'DevToolbox', 'toolbox-manifest.json'), 'utf8').replace(/^\uFEFF/, '')); }
catch { manifest = {}; }
const pythonExecutable = argument('--python-executable', manifest.python?.executable);
const modelPath = argument('--model-path', path.join(extensionDir, 'memory', 'models', 'bge-small.onnx'));
if (!pythonExecutable || !path.isAbsolute(pythonExecutable) || !fs.existsSync(pythonExecutable)) throw new Error('An installed explicit CPU Python executable is required');
if (!path.isAbsolute(modelPath) || !fs.existsSync(modelPath)) throw new Error('An existing CPU bge-small model is required; this check never downloads');
const root = fs.mkdtempSync(path.join(os.tmpdir(), 'acolyte-codex-recall-runtime-'));
const api = require(path.join(extensionDir, 'src', 'codex-recall'));
const report = { root, subject: extensionDir, hashes, harnessSha: sha(fs.readFileSync(__filename)),
  pythonExecutable, pythonVersion: spawnSync(pythonExecutable, ['--version'], { encoding: 'utf8', windowsHide: true }).stdout?.trim(),
  modelPath, modelSha: sha(fs.readFileSync(modelPath)), selectedCase, skipped: [], boundaries: 'Actual CPU embeddings and filesystem cache; synthetic selected Codex passages. No native memory generation, Codex turn, GPU, download or live profile access.', checks: [] };
const reportPath = path.join(root, 'evidence.json');
const fixtures = [];
function fixture(name) {
  const home = path.join(root, name), codexHome = path.join(home, 'selected-codex'), memory = path.join(codexHome, 'memories');
  fs.mkdirSync(memory, { recursive: true });
  const box = { home, codexHome, memory, expected: new Map(), options: { home, codexHome, pythonExecutable, modelPath } };
  box.write = (relative, text) => { const file = path.join(memory, relative); fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, text); box.expected.set(relative, sha(fs.readFileSync(file))); return file; };
  box.remove = relative => { fs.unlinkSync(path.join(memory, relative)); box.expected.delete(relative); };
  fixtures.push(box); return box;
}
function save() { fs.writeFileSync(reportPath, JSON.stringify(report, null, 2) + '\n'); }
function check(id, name, body) {
  if (selectedCase !== 'all' && id !== selectedCase && id !== 'integrity') {
    report.skipped.push({ id, name, reason: 'Focused runtime case: ' + selectedCase });
    console.log('SKIP ' + name + ' (focused case ' + selectedCase + ')');
    return;
  }
  try { const evidence = body(); report.checks.push({ name, status: 'passed', evidence }); console.log('PASS ' + name); }
  catch (error) { report.checks.push({ name, status: 'failed', error: error.message, stack: error.stack }); console.log('FAIL ' + name + ': ' + error.message); }
  save();
}
function semantic(result) {
  assert.equal(result.retrieval.mode, 'hybrid', 'WITNESS actual CPU semantic retrieval must run, fallback is not a pass');
  assert.deepEqual(result.retrieval.providers, ['CPUExecutionProvider']);
  assert.equal(result.retrieval.modelSha, report.modelSha);
  assert.ok(result.retrieval.onnxVersion);
}
function provenance(hit) {
  const bytes = fs.readFileSync(hit.path), text = bytes.toString('utf8');
  assert.equal(text.slice(hit.startOffset, hit.endOffset), hit.text);
  assert.equal(sha(Buffer.from(hit.text)), hit.sha256);
  assert.equal(hit.agent, 'codex');
}
const base = fixture('paraphrases');
base.write('MEMORY.md', '# Task: Languages\nWriting code in dot net is really fun.\n');
base.write('rollout_summaries/vehicle.md', '# Mechanical repair\nThe automobile engine failed because the oil reservoir was empty.\n');
base.write('skills/snapshot/SKILL.md', '# Disk retrieval\nWhen the internet connection is unavailable, use the disk snapshot to retrieve documents.\n');
base.write('memory_summary.md', 'v1\nThe weather outside is freezing cold today.\n');
base.write('raw_memories.md', 'PRIVATE_RAW_SENTINEL software development enjoyment vehicle motor breakdown offline access cached files');
let baseCache;
check('paraphrases', 'paraphrases retrieve registry rollout and skill through actual CPU embeddings', () => {
  const results = [];
  for (const [query, expected] of [['software development enjoyment', 'MEMORY.md'],
    ['vehicle motor breakdown from missing lubrication', 'rollout_summaries/vehicle.md'],
    ['offline access cached files', 'skills/snapshot/SKILL.md']]) {
    const result = api.searchCodexMemory(query, base.options); semantic(result);
    assert.equal(result.chunks[0].relativePath, expected, 'WITNESS semantic paraphrase selects the intended native source');
    assert.ok(result.chunks[0].score > 0, 'WITNESS nonzero vector contribution distinguishes a zero-lexical paraphrase');
    assert.ok(result.chunks.every(hit => hit.bm25 === 0), 'fixture must exercise semantics without lexical matches');
    result.chunks.forEach(provenance);
    assert.equal(result.files.some(file => file.relativePath === 'raw_memories.md'), false);
    baseCache = result.retrieval.cachePath;
    results.push({ query, target: expected, topId: result.chunks[0].id, cosine: result.chunks[0].cosine, retrieval: result.retrieval });
  }
  assert.equal(fs.readFileSync(baseCache, 'utf8').includes('PRIVATE_RAW_SENTINEL'), false);
  assert.equal(fs.readFileSync(baseCache, 'utf8').includes('Writing code'), false, 'cache contains vectors and identities, not source text');
  return results;
});

check('windows', 'late passage content beyond the BGE token cap receives its own semantic window', () => {
  const box = fixture('late-window');
  box.write('MEMORY.md', '# Atmospheric report\nThe weather outside is freezing cold today.\n');
  box.write('skills/baking/SKILL.md', '# Bread\nKnead flour and water before baking bread in the oven.\n');
  box.write('rollout_summaries/late.md', '# Recovered account\n' + 'The weather outside is freezing cold today. '.repeat(70)
    + '\nWriting code in dot net is really fun. '.repeat(5));
  const result = api.searchCodexMemory('software development enjoyment', box.options); semantic(result);
  assert.ok(result.retrieval.windows > result.retrieval.indexedChunks, 'WITNESS long passage requires multiple token windows');
  assert.equal(result.chunks[0].relativePath, 'rollout_summaries/late.md', 'WITNESS late semantic sentence survives prefix truncation');
  assert.ok(result.chunks[0].score > 0);
  assert.equal(result.chunks[0].bm25, 0);
  provenance(result.chunks[0]);
  const cache = JSON.parse(fs.readFileSync(result.retrieval.cachePath, 'utf8'));
  const ends = Object.values(cache.windows).filter(window => window.chunkId === result.chunks[0].id).map(window => window.tokenEnd);
  assert.ok(Math.max(...ends) > 500, 'WITNESS semantic index reaches well beyond the first 256 tokens');
  return { retrieval: result.retrieval, top: result.chunks[0].relativePath, cosine: result.chunks[0].cosine, lastToken: Math.max(...ends) };
});

check('cache', 'source edits deletions rebuild and empty corpus update the private vector cache', () => {
  const box = fixture('incremental');
  box.write('MEMORY.md', '# Task\nWriting code in dot net is really fun.\n');
  box.write('rollout_summaries/old.md', '# Cold\nThe weather outside is freezing cold today.\n');
  const first = api.searchCodexMemory('software', box.options); semantic(first);
  const oldIds = new Set(first.chunks.map(chunk => chunk.id));
  const reused = api.searchCodexMemory('software', box.options); semantic(reused);
  assert.equal(reused.retrieval.embeddedWindows, 0);
  assert.equal(reused.retrieval.reusedWindows, reused.retrieval.windows);
  const file = path.join(box.memory, 'MEMORY.md'), oldStat = fs.statSync(file);
  const original = fs.readFileSync(file, 'utf8');
  box.write('MEMORY.md', original.replace('really fun', 'quite neat'));
  fs.utimesSync(file, oldStat.atime, oldStat.mtime);
  box.remove('rollout_summaries/old.md');
  const edited = api.searchCodexMemory('software', box.options); semantic(edited);
  assert.equal(edited.retrieval.indexedChunks, 1);
  assert.ok(edited.retrieval.embeddedWindows > 0, 'WITNESS same-size restored-mtime edits are keyed by actual content');
  assert.ok(edited.chunks.every(chunk => !oldIds.has(chunk.id)));
  const cache = JSON.parse(fs.readFileSync(edited.retrieval.cachePath, 'utf8'));
  assert.ok(Object.values(cache.windows).every(window => !oldIds.has(window.chunkId)), 'WITNESS deleted and edited entries leave durable cache');
  const rebuilt = api.rebuildCodexMemory(box.options); semantic(rebuilt);
  assert.equal(rebuilt.retrieval.embeddedWindows, rebuilt.retrieval.windows);
  assert.equal(rebuilt.retrieval.reusedWindows, 0);
  assert.equal(rebuilt.chunks.length, 0);
  box.remove('MEMORY.md');
  const empty = api.rebuildCodexMemory(box.options);
  assert.equal(empty.retrieval.mode, 'empty');
  assert.deepEqual(JSON.parse(fs.readFileSync(empty.retrieval.cachePath, 'utf8')).windows, {});
  return { first: first.retrieval, reused: reused.retrieval, edited: edited.retrieval, rebuilt: rebuilt.retrieval, empty: empty.retrieval };
});

check('profiles', 'identical filenames in separate Codex profiles retain independent cache and provenance', () => {
  const box = fixture('two-profiles');
  box.write('MEMORY.md', '# Task\nWriting code in dot net is really fun.\n');
  const first = api.searchCodexMemory('software development enjoyment', box.options); semantic(first);
  const before = sha(fs.readFileSync(first.retrieval.cachePath));
  const secondHome = path.join(box.home, 'other-codex'), secondRoot = path.join(secondHome, 'memories');
  fs.mkdirSync(secondRoot, { recursive: true });
  const secondText = '# Task\nThe weather outside is freezing cold today.\n';
  fs.writeFileSync(path.join(secondRoot, 'MEMORY.md'), secondText);
  const second = api.searchCodexMemory('snowy winter', { ...box.options, codexHome: secondHome }); semantic(second);
  assert.notEqual(first.retrieval.profileId, second.retrieval.profileId);
  assert.notEqual(first.retrieval.cachePath, second.retrieval.cachePath);
  assert.notEqual(first.chunks[0].sourceId, second.chunks[0].sourceId);
  assert.notEqual(first.chunks[0].id, second.chunks[0].id);
  assert.equal(second.chunks[0].path, path.join(secondRoot, 'MEMORY.md'));
  assert.equal(second.chunks[0].text, secondText);
  assert.equal(sha(fs.readFileSync(first.retrieval.cachePath)), before, 'WITNESS another selected profile cannot replace the first cache');
  return { first: first.retrieval, second: second.retrieval };
});

check('foreign-cache', 'foreign profile cache identity is rejected and all vectors are rebuilt', () => {
  if (!baseCache) {
    const baseline = api.searchCodexMemory('software development enjoyment', base.options); semantic(baseline);
    baseCache = baseline.retrieval.cachePath;
  }
  const foreign = JSON.parse(fs.readFileSync(baseCache, 'utf8'));
  foreign.identity.profileId = 'foreign-profile';
  fs.writeFileSync(baseCache, JSON.stringify(foreign));
  const result = api.searchCodexMemory('software development enjoyment', base.options); semantic(result);
  assert.equal(result.retrieval.reusedWindows, 0, 'WITNESS foreign cache profile cannot lend vectors to the current profile');
  assert.equal(result.retrieval.embeddedWindows, result.retrieval.windows);
  assert.match(result.retrieval.cacheWarning, /identity changed/);
  return result.retrieval;
});

check('fallback', 'unavailable runtime and linked private cache report explicit keyword fallback', () => {
  const noPython = api.searchCodexMemory('code', { ...base.options, pythonExecutable: path.join(base.home, 'absent.exe') });
  assert.equal(noPython.retrieval.mode, 'lexical');
  assert.ok(noPython.retrieval.reason);
  assert.equal(noPython.chunks[0].relativePath, 'MEMORY.md');
  const box = fixture('linked-cache'); box.write('MEMORY.md', '# Task\nWriting code is fun.\n');
  const external = path.join(root, 'external-cache'); fs.mkdirSync(external);
  fs.symlinkSync(external, path.join(box.home, '.ai-acolyte'), process.platform === 'win32' ? 'junction' : 'dir');
  const linked = api.searchCodexMemory('code', box.options);
  assert.equal(linked.retrieval.mode, 'lexical', 'WITNESS linked cache parent is refused');
  assert.ok(linked.retrieval.reason);
  assert.deepEqual(fs.readdirSync(external), []);
  return { noPython: noPython.retrieval, linked: linked.retrieval };
});

check('integrity', 'native fixture bytes and staged subject modules remain unchanged', () => {
  for (const box of fixtures) for (const [relative, expected] of box.expected) {
    assert.equal(sha(fs.readFileSync(path.join(box.memory, relative))), expected);
  }
  for (const name of names) assert.equal(sha(fs.readFileSync(path.join(extensionDir, name))), hashes[name]);
  return { subjectUnchanged: true, nativeSourcesUnchanged: true };
});
report.passed = report.checks.filter(check => check.status === 'passed').length;
report.failed = report.checks.length - report.passed;
save();
console.log(JSON.stringify({ passed: report.passed, failed: report.failed, evidence: reportPath }));
process.exitCode = report.failed ? 1 : 0;
