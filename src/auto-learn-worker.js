'use strict';

const { parentPort, workerData } = require('node:worker_threads');
const { createAutoLearnManager } = require('./auto-learn-manager');

function run(data) {
  const operation = data?.operation;
  if (['codexNativeGates', 'setCodexNativeGates', 'refreshCodexNativeGates'].includes(operation)) {
    const { inspectNativeCodexGates, setNativeCodexGates, refreshNativeCodexGates } = require('./codex-memory-gates');
    const options = data?.options || {};
    if (operation === 'codexNativeGates') return inspectNativeCodexGates(options);
    if (operation === 'refreshCodexNativeGates') return refreshNativeCodexGates(options);
    const request = data?.args?.[0] || {};
    return setNativeCodexGates(request.enabled, { fingerprint: request.fingerprint }, options);
  }
  if (operation === 'codexMemorySearch' || operation === 'rebuildCodexMemory') {
    const { searchCodexMemory, rebuildCodexMemory } = require('./codex-recall');
    const supplied = data?.args?.[0] || {};
    const runtime = Object.fromEntries(['pythonExecutable', 'modelPath', 'recallScript']
      .filter((key) => supplied.recallOptions?.[key] !== undefined).map((key) => [key, supplied.recallOptions[key]]));
    const options = { ...(data?.options || {}), ...runtime };
    return operation === 'codexMemorySearch' ? searchCodexMemory(supplied.query, options) : rebuildCodexMemory(options);
  }
  if (operation === 'codexMemory') {
    const { readCodexMemory, queryCodexMemory } = require('./codex-memory');
    const memory = readCodexMemory(data?.options || {});
    const query = data?.args?.[0]?.query;
    return { ...memory, chunks: typeof query === 'string' && query.trim()
      ? queryCodexMemory(memory, query, { limit: 30 }) : [] };
  }
  const manager = createAutoLearnManager(data?.options || {});
  // `rebuildManagedHits` belongs here even though no UI path calls it yet: it is
  // the one remaining manager operation that both mutates state and does real
  // work (it re-reads the managed policy and re-assesses every candidate), so
  // omitting it left a caller two bad options — a worker that rejects the
  // operation, or an in-process call that blocks the extension host. The runner
  // fires onMutation for every operation, so the host's cached manager is
  // invalidated afterwards with no extra wiring.
  if (!['scan', 'apply', 'undo', 'setMode', 'rebuildManagedHits',
    'codexInventory', 'removeCodexRules', 'codexRestoreInventory', 'restoreCodexRules',
    'codexApprovalInventory', 'approveCodexRules',
    'codexMcpInventory', 'planCodexMcp', 'approveCodexMcp', 'undoCodexMcp', 'recoverCodexMcp'].includes(operation)) {
    throw new Error(`Unsupported Auto Learn worker operation: ${operation}`);
  }
  const args = Array.isArray(data?.args) ? data.args : [];
  return manager[operation](...args);
}

if (parentPort) {
  try {
    parentPort.postMessage({ ok: true, result: run(workerData) });
  } catch (error) {
    parentPort.postMessage({
      ok: false,
      error: {
        message: error?.message || String(error),
        code: error?.code || null,
        stack: error?.stack || null,
      },
    });
  }
}

module.exports = { run };
