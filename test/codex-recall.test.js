'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');
const { createRequire } = require('node:module');
const filename = path.resolve(__dirname, '../src/codex-recall.js');
const actualRequire = createRequire(filename);
const { searchCodexMemory } = actualRequire(filename);
const sha = value => crypto.createHash('sha256').update(value).digest('hex');

function fixture(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-recall-test-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }));
  const codexHome = path.join(home, 'selected');
  const memory = path.join(codexHome, 'memories');
  fs.mkdirSync(path.join(memory, 'rollout_summaries'), { recursive: true });
  fs.writeFileSync(path.join(memory, 'MEMORY.md'), '# Task: fixture\nThe violet database is backed up nightly.\n');
  fs.writeFileSync(path.join(memory, 'raw_memories.md'), 'PRIVATE_RAW_DECOY');
  const modelPath = path.join(home, 'bge-small.onnx');
  fs.writeFileSync(modelPath, 'fixture-model-not-executable');
  fs.writeFileSync(path.join(home, 'bge-small.vocab.txt'), 'fixture-vocabulary');
  const pythonExecutable = path.join(home, 'python.exe');
  fs.writeFileSync(pythonExecutable, 'fixture-python-not-executable');
  return { home, codexHome, memory, modelPath, pythonExecutable,
    options: { home, codexHome, modelPath, pythonExecutable } };
}

function load(spawn) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, exports: module.exports, __dirname: path.dirname(filename), Buffer, process,
    require: name => name === 'child_process' ? { spawnSync: spawn } : actualRequire(name),
  }, { filename });
  return module.exports;
}

function response(input) {
  return { schema: 1, profileId: input.profileId, modelSha: input.modelSha, vocabSha: input.vocabSha,
    recallSha: input.recallSha, bridgeSha: input.bridgeSha, mode: input.chunks.length ? 'hybrid' : 'empty',
    providers: input.chunks.length ? ['CPUExecutionProvider'] : [], indexedChunks: input.chunks.length,
    windows: input.chunks.length, embeddedWindows: input.chunks.length, reusedWindows: 0,
    hits: input.operation === 'rebuild' ? [] : input.chunks.slice(0, input.limit).map(chunk => ({ id: chunk.id, score: .7, cosine: .8, bm25: 0 })) };
}

test('missing CPU assets report lexical fallback on every search without changing native files or inventing semantic success', (t) => {
  const box = fixture(t);
  const source = fs.readFileSync(path.join(box.memory, 'MEMORY.md'));
  for (let index = 0; index < 2; index++) {
    const result = searchCodexMemory('violet', { ...box.options, pythonExecutable: path.join(box.home, 'absent.exe') });
    assert.equal(result.retrieval.mode, 'lexical');
    assert.match(result.retrieval.reason, /runtime is unavailable/);
    assert.equal(result.chunks[0].relativePath, 'MEMORY.md');
    assert.equal(result.retrieval.rebuilt, false);
  }
  const noModel = searchCodexMemory('violet', { ...box.options, modelPath: path.join(box.home, 'absent.onnx') });
  assert.equal(noModel.retrieval.mode, 'lexical');
  assert.match(noModel.retrieval.reason, /No download/);
  assert.deepEqual(fs.readFileSync(path.join(box.memory, 'MEMORY.md')), source);
  assert.equal(fs.existsSync(path.join(box.home, '.ai-acolyte')), false);
});

test('semantic bridge receives only selected passages with isolated profile identity and hashed explicit assets', (t) => {
  const box = fixture(t);
  let observed;
  const api = load((python, args, options) => {
    const input = JSON.parse(options.input);
    observed = { python, args, options, input };
    return { status: 0, stdout: JSON.stringify(response(input)) };
  });
  const result = api.searchCodexMemory('archive the storage', box.options);
  assert.equal(result.retrieval.mode, 'hybrid');
  assert.equal(observed.python, box.pythonExecutable);
  assert.equal(observed.args[0], '-I');
  assert.equal(observed.options.env.CUDA_VISIBLE_DEVICES, '-1');
  assert.equal(observed.options.env.RECALL_MEMORY_DIRS, '');
  assert.equal(observed.options.env.CODEX_HOME, box.codexHome);
  assert.equal(observed.options.env.HOME, box.home);
  assert.equal(observed.options.env.OPENAI_API_KEY, undefined);
  assert.equal(observed.options.env.PYTHONPATH, undefined);
  assert.equal(observed.input.chunks.length, 1, 'WITNESS registry selected and raw memory excluded from semantic bridge');
  assert.equal(observed.options.input.includes('PRIVATE_RAW_DECOY'), false);
  assert.equal(observed.input.modelSha, sha(fs.readFileSync(box.modelPath)));
  assert.equal(observed.input.profileId, sha(process.platform === 'win32' ? box.codexHome.toLowerCase() : box.codexHome));
  assert.equal(observed.input.cachePath, path.join(box.home, '.ai-acolyte', 'codex', observed.input.profileId, 'recall', 'index.json'));
  assert.equal(result.chunks[0].path, path.join(box.memory, 'MEMORY.md'));
  assert.equal(result.chunks[0].text, fs.readFileSync(result.chunks[0].path, 'utf8'));
  assert.equal(result.chunks[0].startOffset, 0);
  assert.equal(result.chunks[0].cosine, .8);
});

test('wrong profile model provider and passage responses cannot be reported as semantic results', (t) => {
  const box = fixture(t);
  const variants = [
    output => { output.profileId = 'wrong'; }, output => { output.modelSha = 'wrong'; },
    output => { output.providers = ['CUDAExecutionProvider']; }, output => { output.mode = 'lexical'; },
    output => { output.hits[0].id = 'not-an-adapter-passage'; }, output => { output.hits = []; },
    output => { output.windows = 0; }, output => { output.embeddedWindows = -1; },
    output => { output.hits[0].score = '0.8'; },
  ];
  for (const mutate of variants) {
    const api = load((_python, _args, options) => {
      const output = response(JSON.parse(options.input)); mutate(output);
      return { status: 0, stdout: JSON.stringify(output) };
    });
    const result = api.searchCodexMemory('violet', box.options);
    assert.equal(result.retrieval.mode, 'lexical', 'WITNESS invalid semantic provenance or execution metadata is explicit fallback');
    assert.match(result.retrieval.reason, /invalid or mismatched/);
    assert.equal(result.chunks[0].cosine, undefined);
  }
});

test('CPU process failure timeout and invalid output are visible fallback without leaking stderr or query text', (t) => {
  const box = fixture(t);
  for (const processResult of [{ status: 1, stderr: 'PRIVATE_TRACE' }, { error: { code: 'ETIMEDOUT' } },
    { status: 0, stdout: 'PRIVATE_QUERY: bad json' }]) {
    const api = load(() => processResult);
    const result = api.searchCodexMemory('violet', box.options);
    assert.equal(result.retrieval.mode, 'lexical');
    assert.ok(result.retrieval.reason);
    assert.equal(JSON.stringify(result.retrieval).includes('PRIVATE_'), false);
  }
});

test('rebuild requests force fresh vectors and expose counts without returning search passages', (t) => {
  const box = fixture(t);
  let operation;
  const api = load((_python, _args, options) => {
    const input = JSON.parse(options.input); operation = input.operation;
    return { status: 0, stdout: JSON.stringify(response(input)) };
  });
  const result = api.rebuildCodexMemory(box.options);
  assert.equal(operation, 'rebuild');
  assert.equal(result.retrieval.rebuilt, true);
  assert.equal(result.retrieval.indexedChunks, 1);
  assert.equal(result.chunks.length, 0);
});

test('explicit query and runtime path options are validated without invoking a process', (t) => {
  const box = fixture(t);
  let calls = 0;
  const api = load(() => { calls++; throw new Error('unexpected spawn'); });
  assert.throws(() => api.searchCodexMemory('', box.options), /nonempty/);
  assert.throws(() => api.searchCodexMemory('q', { ...box.options, pythonExecutable: 'python' }), /absolute/);
  assert.throws(() => api.searchCodexMemory('q', { ...box.options, modelPath: 'model.onnx' }), /absolute/);
  assert.throws(() => api.searchCodexMemory('q', { ...box.options, limit: 0 }), /limit/);
  assert.equal(calls, 0);
});
