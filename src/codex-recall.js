'use strict';

// Codex's selected passage corpus is independent of Claude's directory index.
// Python receives these exact passages on stdin; it never discovers native files.
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const { readCodexMemory, queryCodexMemory } = require('./codex-memory');

const sha = (value) => crypto.createHash('sha256').update(value).digest('hex');
const canonical = (value) => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const BRIDGE = path.resolve(__dirname, '..', 'memory', 'codex_recall.py');
const DEFAULT_RECALL = path.resolve(__dirname, '..', 'memory', 'recall.py');

function ordinary(file) {
  try { const stat = fs.lstatSync(file); return stat.isFile() && !stat.isSymbolicLink(); }
  catch { return false; }
}

function explicitPath(value, name) {
  if (typeof value !== 'string' || !path.isAbsolute(value)) throw new TypeError(`${name} must be an absolute path`);
  return path.resolve(value);
}

function pythonPath(options) {
  if (options.pythonExecutable !== undefined) return explicitPath(options.pythonExecutable, 'pythonExecutable');
  if (process.env.TOOLBOX_PYTHON && path.isAbsolute(process.env.TOOLBOX_PYTHON) && ordinary(process.env.TOOLBOX_PYTHON)) {
    return process.env.TOOLBOX_PYTHON;
  }
  if (process.env.LOCALAPPDATA) {
    try {
      const manifest = JSON.parse(fs.readFileSync(path.join(process.env.LOCALAPPDATA, 'DevToolbox', 'toolbox-manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
      const executable = manifest.python?.executable;
      if (typeof executable === 'string' && path.isAbsolute(executable)) return executable;
    } catch { /* an absent estate is an explicit lexical fallback */ }
  }
  return null;
}

function assets(options, home) {
  const recallScript = options.recallScript === undefined ? DEFAULT_RECALL : explicitPath(options.recallScript, 'recallScript');
  const pythonExecutable = pythonPath(options);
  const candidates = options.modelPath === undefined ? [
    process.env.RECALL_MODEL_DIR && path.isAbsolute(process.env.RECALL_MODEL_DIR)
      ? path.join(process.env.RECALL_MODEL_DIR, 'bge-small.onnx') : null,
    path.join(home, '.claude', 'wildcarding', 'models', 'bge-small.onnx'),
    path.join(path.dirname(recallScript), 'models', 'bge-small.onnx'),
  ].filter(Boolean) : [explicitPath(options.modelPath, 'modelPath')];
  const modelPath = candidates.find((candidate) => path.basename(candidate) === 'bge-small.onnx' && ordinary(candidate) &&
    ordinary(path.join(path.dirname(candidate), 'bge-small.vocab.txt')));
  const result = { pythonExecutable, recallScript, bridgePath: BRIDGE, modelPath: modelPath || null };
  if (!pythonExecutable || !ordinary(pythonExecutable)) return { ...result, reason: 'The configured CPU Python runtime is unavailable.' };
  if (!modelPath) return { ...result, reason: 'The existing bge-small CPU model and vocabulary are unavailable. No download was attempted.' };
  if (!ordinary(recallScript) || !ordinary(BRIDGE)) return { ...result, reason: 'The shipped CPU recall bridge or recall.py is unavailable.' };
  result.vocabPath = path.join(path.dirname(modelPath), 'bge-small.vocab.txt');
  for (const [name, file] of [['modelSha', modelPath], ['vocabSha', result.vocabPath], ['recallSha', recallScript], ['bridgeSha', BRIDGE]]) {
    result[name] = sha(fs.readFileSync(file));
  }
  return result;
}

function cacheLocation(home, codexHome) {
  const profileId = sha(canonical(codexHome));
  return { profileId, cachePath: path.join(home, '.ai-acolyte', 'codex', profileId, 'recall', 'index.json') };
}

function run(query, options, rebuild) {
  const home = explicitPath(options.home === undefined ? os.homedir() : options.home, 'home');
  const memory = readCodexMemory(options);
  const location = cacheLocation(home, memory.codexHome);
  const limit = options.limit === undefined ? 30 : options.limit;
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 1000) throw new TypeError('limit must be an integer between 1 and 1000');
  const fallback = (reason, extra = {}) => ({ ...memory,
    chunks: rebuild ? [] : queryCodexMemory(memory, query, { limit }),
    retrieval: { mode: 'lexical', reason, agent: 'codex', ...location, rebuilt: false,
      indexedChunks: 0, ...extra } });
  let runtime;
  try { runtime = assets(options, home); }
  catch (error) {
    if (error instanceof TypeError) throw error;
    return fallback(`CPU recall assets could not be read (${error.code || 'read failure'}).`);
  }
  const identity = { ...location, modelSha: runtime.modelSha || null, vocabSha: runtime.vocabSha || null,
    recallSha: runtime.recallSha || null, bridgeSha: runtime.bridgeSha || null };
  if (runtime.reason) return fallback(runtime.reason, identity);
  const timeout = options.timeoutMs === undefined ? 180000 : options.timeoutMs;
  if (!Number.isSafeInteger(timeout) || timeout < 1) throw new TypeError('timeoutMs must be a positive integer');
  const input = { schema: 1, operation: rebuild ? 'rebuild' : 'search', query, limit,
    home, codexHome: memory.codexHome, ...identity,
    modelPath: runtime.modelPath, vocabPath: runtime.vocabPath, recallScript: runtime.recallScript,
    chunks: memory.chunks.map(({ id, text, sha256, sourceId }) => ({ id, text, sha256, sourceId })) };
  // Pin legacy recall.py's globals before import so it cannot discover Claude
  // memory, and prevent user Python import paths or bytecode writes.
  const env = { ...process.env, RECALL_REEXEC: '1', RECALL_MODEL_DIR: path.dirname(runtime.modelPath),
    RECALL_MEMORY_DIR: path.dirname(location.cachePath), RECALL_MEMORY_DIRS: '', PYTHONDONTWRITEBYTECODE: '1',
    HOME: home, USERPROFILE: home, CODEX_HOME: memory.codexHome,
    CUDA_VISIBLE_DEVICES: '-1', HF_HUB_OFFLINE: '1', TRANSFORMERS_OFFLINE: '1' };
  delete env.PYTHONPATH;
  for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL']) delete env[name];
  const processResult = spawnSync(runtime.pythonExecutable, ['-I', '-B', BRIDGE], {
    input: JSON.stringify(input), encoding: 'utf8', env, timeout, maxBuffer: 32 * 1024 * 1024, windowsHide: true,
  });
  if (processResult.error || processResult.status !== 0) {
    const failure = processResult.error?.code || (processResult.signal ? 'terminated' : `exit ${processResult.status}`);
    // No private passage, query or raw traceback is included in the fallback.
    return fallback(`CPU semantic recall could not complete (${failure}); showing keyword matches.`, identity);
  }
  try {
    const output = JSON.parse(processResult.stdout);
    if (output.schema !== 1 || output.profileId !== location.profileId || output.modelSha !== runtime.modelSha ||
      output.vocabSha !== runtime.vocabSha || output.recallSha !== runtime.recallSha || output.bridgeSha !== runtime.bridgeSha ||
      !['hybrid', 'empty'].includes(output.mode) || !Array.isArray(output.hits) ||
      !Number.isSafeInteger(output.indexedChunks) || output.indexedChunks !== memory.chunks.length ||
      !Number.isSafeInteger(output.windows) || output.windows < memory.chunks.length ||
      !Number.isSafeInteger(output.embeddedWindows) || output.embeddedWindows < 0 ||
      !Number.isSafeInteger(output.reusedWindows) || output.reusedWindows < 0 ||
      output.embeddedWindows + output.reusedWindows !== output.windows ||
      (!memory.chunks.length && (output.mode !== 'empty' || output.windows !== 0)) ||
      (memory.chunks.length && (output.mode !== 'hybrid' || !Array.isArray(output.providers) ||
        output.providers.length !== 1 || output.providers[0] !== 'CPUExecutionProvider'))) {
      throw new Error('CPU bridge identity or mode mismatch');
    }
    const byId = new Map(memory.chunks.map((chunk) => [chunk.id, chunk]));
    const seen = new Set();
    const chunks = output.hits.map((hit) => {
      if (!byId.has(hit.id) || seen.has(hit.id) || !Number.isFinite(hit.score) || !Number.isFinite(hit.cosine) ||
        !Number.isFinite(hit.bm25)) throw new Error('CPU bridge returned an invalid passage');
      seen.add(hit.id);
      return { ...byId.get(hit.id), score: hit.score, cosine: hit.cosine, bm25: hit.bm25 };
    });
    if (chunks.length !== (rebuild ? 0 : Math.min(limit, memory.chunks.length))) throw new Error('CPU bridge result count mismatch');
    return { ...memory, chunks, retrieval: { mode: output.mode, agent: 'codex', ...identity,
      providers: output.providers, indexedChunks: output.indexedChunks, windows: output.windows,
      onnxVersion: output.onnxVersion || null,
      embeddedWindows: output.embeddedWindows, reusedWindows: output.reusedWindows,
      rebuilt: rebuild, ...(output.cacheWarning ? { cacheWarning: output.cacheWarning } : {}) } };
  } catch {
    return fallback('CPU semantic recall returned an invalid or mismatched result; showing keyword matches.', identity);
  }
}

function searchCodexMemory(query, options = {}) {
  if (typeof query !== 'string' || !query.trim()) throw new TypeError('A nonempty Codex memory query is required');
  return run(query.trim(), options, false);
}

function rebuildCodexMemory(options = {}) { return run('', options, true); }

module.exports = { searchCodexMemory, rebuildCodexMemory };
