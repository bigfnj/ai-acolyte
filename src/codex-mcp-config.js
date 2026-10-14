'use strict';

// Exact reviewed MCP approval changes only. The caller must hold the shared
// policy lock across inspect/apply/restore/recovery and check assertReady before
// every other Codex policy writer. No thread or turn is started by this module.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync, spawn } = require('node:child_process');
const { resolveCodexHome } = require('./codex-paths');
const { commandLaunch, endProcessTree, npmShimLaunch } = require('./exec-resolve');
const { writeFileAtomicSync } = require('./permissions');

const MODES = new Set(['auto', 'prompt', 'writes', 'approve']);
const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const hash = value => crypto.createHash('sha256').update(value).digest('hex');
const normalized = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
const validName = value => typeof value === 'string' && /^[A-Za-z0-9_.-]{1,128}$/.test(value);
const own = (value, name) => object(value) && Object.hasOwn(value, name);
const canonical = value => Array.isArray(value) ? value.map(canonical)
  : object(value) ? Object.fromEntries(Object.keys(value).sort().map(key => [key, canonical(value[key])])) : value;
const semanticHash = value => hash(JSON.stringify(canonical(value)));

function paths(options) {
  const home = options.home === undefined ? os.homedir() : path.resolve(options.home);
  const codexHome = resolveCodexHome(options);
  const scope = normalized(codexHome), id = hash(scope).slice(0, 16);
  return { home, codexHome, scope, file: path.join(codexHome, 'config.toml'),
    ledger: path.join(home, '.ai-acolyte', `codex-mcp.${id}.json`),
    backups: path.join(home, '.ai-acolyte', 'backups', `codex-mcp.${id}`) };
}

function readFile(file) {
  ordinaryParents(file);
  let stat;
  try { stat = fs.lstatSync(file); }
  catch (error) { if (error.code === 'ENOENT') return { exists: false, text: '', hash: hash('') }; throw error; }
  if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Codex MCP files must be ordinary files');
  const bytes = fs.readFileSync(file), text = bytes.toString('utf8');
  if (!Buffer.from(text, 'utf8').equals(bytes)) throw new Error('Codex MCP files must contain valid UTF-8');
  return { exists: true, text, hash: hash(bytes) };
}

function ordinaryParents(file) {
  const resolved = path.resolve(file), root = path.parse(resolved).root;
  let current = root;
  for (const part of path.relative(root, path.dirname(resolved)).split(path.sep).filter(Boolean)) {
    current = path.join(current, part);
    let stat;
    try { stat = fs.lstatSync(current); } catch (error) {
      if (error.code === 'ENOENT') return false;
      throw error;
    }
    if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Linked or non-directory Codex MCP parent is unsupported: ' + current);
  }
  return true;
}

function atomicText(file, text) {
  ordinaryParents(file);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  ordinaryParents(file);
  readFile(file);
  writeFileAtomicSync(file, text);
}

function atomicJson(file, value) {
  atomicText(file, JSON.stringify(value, null, 2) + '\n');
}

function validRecord(record, context) {
  if (!object(record) || !/^[a-f0-9]{32}$/.test(record.id) || !validName(record.server) || !validName(record.tool) ||
      record.path !== context.file || !/^[a-f0-9]{64}$/.test(record.beforeHash) ||
      typeof record.beforeVersion !== 'string' || !object(record.beforeApproval) ||
      typeof record.beforeApproval.exists !== 'boolean' ||
      (record.beforeApproval.exists ? !MODES.has(record.beforeApproval.value) : record.beforeApproval.value !== null) ||
      !object(record.beforeStructure) || typeof record.beforeStructure.toolsExists !== 'boolean' ||
      typeof record.beforeStructure.toolExists !== 'boolean' ||
      (record.beforeStructure.toolExists && !record.beforeStructure.toolsExists) ||
      !['approval', 'tool', 'tools'].includes(record.editLevel) ||
      !/^[a-f0-9]{64}$/.test(record.beforeSemanticHash) || !/^[a-f0-9]{64}$/.test(record.afterSemanticHash) ||
      !['approve', 'restore'].includes(record.action) ||
      (record.desiredValue !== null && !MODES.has(record.desiredValue))) {
    throw new Error('Codex MCP approval records are malformed or unsupported');
  }
  if (record.action === 'approve' && (record.desiredValue !== 'approve' || record.editLevel !== 'approval')) throw new Error('Codex MCP grant record has an invalid target');
  if (record.editLevel !== 'approval' && record.desiredValue !== null) throw new Error('Codex MCP table removal has an invalid target');
  if (record.action === 'restore' && !/^[a-f0-9]{32}$/.test(record.restores)) throw new Error('Codex MCP restore record has no receipt');
  if (record.afterHash !== undefined && (!/^[a-f0-9]{64}$/.test(record.afterHash) || typeof record.afterVersion !== 'string')) {
    throw new Error('Codex MCP completed receipt is malformed');
  }
  return record;
}

function load(context) {
  const read = readFile(context.ledger);
  if (!read.exists) return { version: 1, scope: context.scope, pending: null, receipts: [] };
  let state;
  try { state = JSON.parse(read.text); } catch { throw new Error('Codex MCP approval records cannot be read'); }
  if (!object(state) || state.version !== 1 || state.scope !== context.scope || !Array.isArray(state.receipts) ||
      (state.pending !== null && !object(state.pending))) throw new Error('Codex MCP approval records are malformed or unsupported');
  const ids = new Set();
  const restored = new Set();
  const validateRestore = record => {
    if (record.action !== 'restore') return;
    const original = state.receipts.find(item => item.id === record.restores && item.action === 'approve' && ids.has(item.id));
    if (!original || restored.has(record.restores) || original.server !== record.server || original.tool !== record.tool ||
        record.desiredValue !== original.beforeApproval.value || record.beforeHash !== original.afterHash ||
        record.beforeVersion !== original.afterVersion || record.beforeSemanticHash !== original.afterSemanticHash) {
      throw new Error('Codex MCP restore records have invalid receipt authority');
    }
    restored.add(record.restores);
  };
  for (const record of state.receipts) {
    validRecord(record, context);
    if (!record.afterHash || ids.has(record.id)) throw new Error('Codex MCP receipts are incomplete or duplicated');
    validateRestore(record);
    ids.add(record.id);
  }
  if (state.pending) {
    validRecord(state.pending, context);
    if (ids.has(state.pending.id)) throw new Error('Codex MCP pending intent duplicates a completed receipt');
    validateRestore(state.pending);
  }
  return state;
}

function nativeRpc(requests, options, context) {
  ordinaryParents(context.file);
  ordinaryParents(path.join(context.home, '.ai-acolyte'));
  const launch = commandLaunch(options.nodeExecutable || 'node', [__filename, '--rpc-worker']);
  if (!launch.resolved) throw new Error('A Node executable is required for Codex config RPC');
  const result = spawnSync(launch.file, launch.args, { ...launch.options, windowsHide: true,
    input: JSON.stringify({ requests, home: context.home, codexHome: context.codexHome,
      codexExecutable: options.codexExecutable || 'codex' }), encoding: 'utf8', timeout: 40000,
    maxBuffer: 16 * 1024 * 1024 });
  if (result.error) throw new Error('Codex config RPC is unavailable: ' + result.error.message.slice(0, 600));
  let output;
  try { output = JSON.parse(result.stdout); } catch { throw new Error('Codex config RPC returned unreadable data'); }
  if (output.error) throw new Error('Codex config RPC refused: ' + String(output.error).slice(0, 600));
  if (result.status !== 0) throw new Error('Codex config RPC worker failed');
  if (!Array.isArray(output.results) || output.results.length !== requests.length) throw new Error('Codex config RPC returned incomplete data');
  return output.results;
}

// The same worker as nativeRpc, for a caller that must not block: the extension
// host (2026-10-14; src/codex-policy.js "THE ASK NEVER RUNS ON THE EXTENSION HOST
// THREAD" has the measurements that made spawnSync there a defect). Read-only
// requests only, and bounded by `options.timeoutMs` end to end:
//
//   - the worker's own Codex calls end at `deadlineAt`, timeoutMs - 3 s after
//     this call began, and, being read-only, it then gives its app-server a 1 s
//     grace before it tree-kills it, so a codex that never answers is ended by
//     the worker that started it;
//   - this side arms a backstop at timeoutMs that tree-kills the WORKER, for a
//     worker that is itself wedged. taskkill /T on Windows, because the worker's
//     codex is a grandchild of this process and child.kill() ends only the child;
//     an npm `codex.cmd` adds a cmd.exe between them as well.
//
// `options.track` receives the child, so the extension's deactivate can end it
// (and, through the same tree kill, everything under it). Failure messages match
// nativeRpc's, so callers matching "not reachable" read both alike.
//
// SPAWN, NOT execFile (2026-10-14). This launched the worker with
// `execFile(..., { detached })`, and execFile passes spawn a fixed list of its
// options (cwd, env, gid, shell, signal, uid, windowsHide,
// windowsVerbatimArguments) and drops every other one without a word. So the
// worker was never a process-group leader on POSIX, endProcessTree's `-pid`
// signal failed with ESRCH, and only the worker died: on all three Ubuntu CI
// legs (run 38525363435) deactivate left the hung stand-in codex running, which
// is exactly where a Linux or macOS user's real `codex app-server` would have
// been left, orphaned, holding its stdio. spawn honours `detached`, so the
// output is gathered here instead, with execFile's 16 MiB bound and the same
// failure shapes. The worker does not detach its app-server (see the worker
// below), so the group the host signals is the whole tree.
//
// THE DEADLINE IS A TIME, NOT A LENGTH (2026-10-14). It was `deadlineMs`, counted
// from when the worker armed it, which is after the worker has started, loaded
// this module and spawned its codex. None of that was budgeted, and after the
// deadline the worker still spends its grace plus a taskkill before it exits, so
// the graceful path had to fit startup + taskkill into 2 s of the 3 s margin. CI
// run 38535034218 (Node 20, windows-latest only) did not: the backstop tree-killed
// the worker first and the answer read "unavailable: the worker timed out". Both
// paths end the codex, and both read as a timeout to the 60 s retry in
// src/codex-policy.js, but the worker is the one that can end its codex
// gracefully, so it has to be the one that fires first. `deadlineAt` is now
// fixed when this call starts (or at `options.startedAt`, for a caller that
// started the clock earlier), so however long the worker takes to start, the
// whole 3 s margin is left for the grace, the kill and the exit.
const WORKER_OUTPUT_LIMIT = 16 * 1024 * 1024;
const WORKER_MARGIN_MS = 3000;
function nativeRpcAsync(requests, options, context) {
  const startedAt = Number.isFinite(options.startedAt) ? options.startedAt : Date.now();
  return new Promise((resolve, reject) => {
    if (!requests.every((item) => item?.method === 'config/read')) {
      throw new Error('The asynchronous Codex config RPC is read-only');
    }
    ordinaryParents(context.file);
    ordinaryParents(path.join(context.home, '.ai-acolyte'));
    const launch = commandLaunch(options.nodeExecutable || 'node', [__filename, '--rpc-worker']);
    if (!launch.resolved) throw new Error('A Node executable is required for Codex config RPC');
    const timeoutMs = Math.min(40000, Math.max(4000, Number(options.timeoutMs) || 10000));
    let timedOut = false;
    let backstop = null;
    let settled = false;
    let stdout = '';
    let stderr = '';
    let overflow = false;
    const finish = (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(backstop);
      if (timedOut) { reject(new Error('Codex config RPC is unavailable: the worker timed out')); return; }
      if (error && !stdout.trim()) {
        reject(new Error('Codex config RPC is unavailable: ' + String(error.message || error).slice(0, 600)));
        return;
      }
      let output;
      try { output = JSON.parse(stdout); } catch { reject(new Error('Codex config RPC returned unreadable data')); return; }
      if (output.error) { reject(new Error('Codex config RPC refused: ' + String(output.error).slice(0, 600))); return; }
      if (error) { reject(new Error('Codex config RPC worker failed')); return; }
      if (!Array.isArray(output.results) || output.results.length !== requests.length) {
        reject(new Error('Codex config RPC returned incomplete data'));
        return;
      }
      resolve(output.results);
    };
    // `detached` on POSIX only: it makes the worker a process-group leader, so the
    // tree kill (endProcessTree) reaches its codex as well. On Windows it would
    // open a console; the tree kill there is taskkill /T and needs no group.
    const child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'], detached: process.platform !== 'win32' });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      if (overflow) return;
      stdout += chunk;
      if (stdout.length > WORKER_OUTPUT_LIMIT) { overflow = true; endProcessTree(child); }
    });
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', (chunk) => { if (stderr.length < 4096) stderr += chunk; });
    // A launch failure emits 'error' and may never emit 'close'; `settled` keeps
    // whichever comes second from answering twice.
    child.once('error', finish);
    child.once('close', (code, signal) => finish(code === 0 && !overflow ? null
      : new Error(overflow ? `worker output passed ${WORKER_OUTPUT_LIMIT} bytes`
        : `Command failed: the worker exited ${code ?? signal}${stderr.trim() ? `: ${stderr.trim()}` : ''}`)));
    backstop = setTimeout(() => { timedOut = true; endProcessTree(child); }, timeoutMs);
    child.stdin?.on('error', () => {});
    child.stdin?.end(JSON.stringify({ requests, home: context.home, codexHome: context.codexHome,
      codexExecutable: options.codexExecutable || 'codex', deadlineAt: startedAt + timeoutMs - WORKER_MARGIN_MS }));
    if (typeof options.track === 'function') options.track(child);
  });
}

function rpc(requests, options, context) {
  return (options.rpc || nativeRpc)(requests, options, context);
}

function readConfig(options, context) {
  const before = readFile(context.file);
  if (!before.exists) throw new Error('Codex config.toml is missing; configure the server in Codex first');
  const [response] = rpc([{ method: 'config/read', params: { cwd: options.workspaceRoot || null, includeLayers: true } }], options, context);
  const after = readFile(context.file);
  if (before.hash !== after.hash || before.exists !== after.exists) throw new Error('Codex config changed during inspection');
  if (!object(response?.config) || !Array.isArray(response.layers)) throw new Error('Codex config/read does not support effective layered inspection');
  const users = response.layers.filter(layer => layer.name?.type === 'user' &&
    typeof layer.name.file === 'string' && normalized(layer.name.file) === normalized(context.file) && !layer.name.profile);
  if (users.length !== 1 || !object(users[0].config) || typeof users[0].version !== 'string') {
    throw new Error('Codex did not identify one unprofiled user config source');
  }
  return { snapshot: before, response, user: users[0], semanticHash: semanticHash(users[0].config) };
}

// Codex's own layered view for one cwd and nothing more: no config.toml is
// required, nothing is compared or written, and the worker refuses any method
// but config/read and config/value/write (this sends only the first).
// src/codex-policy.js asks it which project `.codex` folders a session in that
// cwd would load, because Codex decides project trust with matching rules a
// TOML read gets wrong (measured 2026-10-13, codex-cli 0.161.0; the evidence is
// under "project rule directories" there). `rpc` is injectable as above.
function readCodexConfigLayers(options = {}) {
  const context = paths(options);
  const [response] = rpc([{ method: 'config/read', params: { cwd: options.workspaceRoot || null, includeLayers: true } }], options, context);
  if (!object(response) || !Array.isArray(response.layers)) throw new Error('Codex config/read did not return layers');
  return response;
}

// The same read without blocking the caller (nativeRpcAsync above). An injected
// `rpc` may return its results or a promise of them; a test uses the promise to
// hold the answer back. `offThread: true` (the extension host's ask) runs the
// same nativeRpcAsync on a worker thread, because even its spawn held the host
// for about 200 ms on the development box (src/spawn-thread.js).
async function readCodexConfigLayersAsync(options = {}) {
  const context = paths(options);
  const requests = [{ method: 'config/read', params: { cwd: options.workspaceRoot || null, includeLayers: true } }];
  const [response] = await (options.rpc ? options.rpc(requests, options, context)
    : options.offThread === true ? require('./spawn-thread').configRpcOffThread(requests, options, context)
      : nativeRpcAsync(requests, options, context));
  if (!object(response) || !Array.isArray(response.layers)) throw new Error('Codex config/read did not return layers');
  return response;
}

function inspectInternal(options, context, inspectedConfig) {
  const { server, tool } = options;
  if (!validName(server) || !validName(tool)) throw new Error('Codex MCP server and tool names must be exact supported identifiers');
  const current = inspectedConfig || readConfig(options, context);
  const raw = current.user.config.mcp_servers?.[server];
  if (!object(raw) || !(typeof raw.command === 'string' || typeof raw.url === 'string')) {
    throw new Error('This MCP server is not configured in the user config; plugin and other-layer servers are read-only');
  }
  for (const layer of current.response.layers) {
    if (layer === current.user) continue;
    if (own(layer.config?.mcp_servers, server)) throw new Error('This MCP server has configuration in another layer; approval changes are read-only');
  }
  const effective = current.response.config.mcp_servers?.[server];
  if (!object(effective)) throw new Error('The configured MCP server is absent from effective Codex config');
  if (raw.enabled === false || effective.enabled === false || raw.tools?.[tool]?.enabled === false || effective.tools?.[tool]?.enabled === false ||
      [raw, effective].some(value => (Array.isArray(value.enabled_tools) && !value.enabled_tools.includes(tool)) ||
        (Array.isArray(value.disabled_tools) && value.disabled_tools.includes(tool)))) {
    throw new Error('This MCP server or exact tool is disabled; approval does not enable it');
  }
  const beforeApproval = { exists: own(raw.tools?.[tool], 'approval_mode'), value: raw.tools?.[tool]?.approval_mode ?? null };
  const beforeStructure = { toolsExists: own(raw, 'tools'), toolExists: own(raw.tools, tool) };
  if ((beforeApproval.exists && !MODES.has(beforeApproval.value)) ||
      (effective.tools?.[tool]?.approval_mode != null && !MODES.has(effective.tools[tool].approval_mode))) {
    throw new Error('Codex MCP approval mode is unsupported');
  }
  const keyPath = ['mcp_servers', JSON.stringify(server), 'tools', JSON.stringify(tool), 'approval_mode'].join('.');
  const view = { supported: true, server, tool,
    source: { path: context.file, exists: true, hash: current.snapshot.hash, version: current.user.version, origin: 'user' },
    explicitApprovalMode: beforeApproval.value,
    effectiveApprovalMode: effective.tools?.[tool]?.approval_mode ?? effective.default_tools_approval_mode ?? null,
    target: { keyPath, value: 'approve' }, normalizesLineEndings: true };
  view.fingerprint = semanticHash(view);
  return { current, beforeApproval, beforeStructure, view };
}

function inspectCodexMcpTool(options = {}) {
  const context = paths(options);
  try { return inspectInternal(options, context).view; }
  catch (error) { return { supported: false, server: options.server, tool: options.tool, path: context.file, reason: error.message }; }
}

function planCodexMcpApproval(options = {}) {
  const view = inspectCodexMcpTool(options);
  return view.supported ? { ...view, reviewRequired: true, autoApply: false } : view;
}

function inspectPending(options = {}) {
  const context = paths(options), state = load(context);
  if (!state.pending) return null;
  const { id, action, server, tool, beforeHash } = state.pending;
  const current = readFile(context.file);
  return { id, action, server, tool, path: context.file, beforeHash,
    currentHash: current.hash, currentExists: current.exists,
    backupPath: path.join(context.backups, id + '.toml'),
    reason: 'A Codex MCP config change needs explicit recovery before any policy write' };
}

function listCodexMcpApprovals(options = {}) {
  const context = paths(options), state = load(context), pending = inspectPending(options);
  const receipts = state.receipts.filter(record => record.action === 'approve');
  let current, readError;
  if (receipts.length && !pending) {
    try { current = readFile(context.file); } catch (error) { readError = error.message; }
  }
  return receipts.map(record => {
    const restored = state.receipts.some(other => other.restores === record.id);
    const result = { id: record.id, server: record.server, tool: record.tool, path: record.path,
      restored, undoable: false, beforeApproval: { ...record.beforeApproval }, afterHash: record.afterHash,
      backupPath: path.join(context.backups, record.id + '.toml') };
    if (restored) return { ...result, reason: 'This approval receipt was already restored' };
    if (pending) return { ...result, reason: pending.reason };
    if (readError) return { ...result, reason: readError };
    try {
      if (!current.exists || current.hash !== record.afterHash) return { ...result, reason: 'Config changed after this approval; restoration requires manual review' };
      if (readFile(result.backupPath).hash !== record.beforeHash) return { ...result, reason: 'The pre-change backup is missing or changed' };
      return { ...result, undoable: true };
    } catch (error) { return { ...result, reason: error.message }; }
  });
}

function assertReady(options = {}) {
  const pending = inspectPending(options);
  if (pending) throw new Error(`Codex MCP change ${pending.id} is pending; inspect and finish it before writing policy`);
  return true;
}

function changedSemantic(current, server, tool, value, level) {
  const next = JSON.parse(JSON.stringify(current.user.config));
  const configured = next.mcp_servers[server];
  if (value === null) {
    if (level === 'tools') delete configured.tools;
    else if (level === 'tool') delete configured.tools[tool];
    else if (object(configured.tools?.[tool])) delete configured.tools[tool].approval_mode;
  } else {
    if (!object(configured.tools)) configured.tools = {};
    if (!object(configured.tools[tool])) configured.tools[tool] = {};
    configured.tools[tool].approval_mode = value;
  }
  return semanticHash(next);
}

function finishRecord(state, record, inspected, context) {
  if (inspected.current.semanticHash !== record.afterSemanticHash ||
      inspected.beforeApproval.exists !== (record.desiredValue !== null) ||
      inspected.beforeApproval.value !== record.desiredValue ||
      (record.action === 'approve' && inspected.view.effectiveApprovalMode !== 'approve')) {
    throw new Error('Pending Codex MCP config has unexpected semantics or effective policy; manual review is required');
  }
  const backup = readFile(path.join(context.backups, record.id + '.toml'));
  if (!backup.exists || backup.hash !== record.beforeHash) throw new Error('Pending Codex MCP backup is missing or changed; intent was retained');
  const receipt = { ...record, afterHash: inspected.view.source.hash, afterVersion: inspected.view.source.version };
  state.receipts.push(receipt);
  state.pending = null;
  atomicJson(context.ledger, state);
  return { changed: true, receiptId: receipt.id, server: receipt.server, tool: receipt.tool, path: context.file,
    beforeHash: receipt.beforeHash, afterHash: receipt.afterHash, normalizesLineEndings: true,
    backupPath: path.join(context.backups, receipt.id + '.toml') };
}

function performChange(inspected, desiredValue, action, restores, options, context, state, editLevel = 'approval') {
  const { view, current, beforeApproval, beforeStructure } = inspected;
  const id = crypto.randomBytes(16).toString('hex');
  const record = { id, action, server: view.server, tool: view.tool, path: context.file,
    beforeHash: view.source.hash, beforeVersion: view.source.version, beforeApproval, beforeStructure, editLevel,
    beforeSemanticHash: current.semanticHash,
    afterSemanticHash: changedSemantic(current, view.server, view.tool, desiredValue, editLevel), desiredValue,
    ...(restores ? { restores } : {}) };
  atomicText(path.join(context.backups, id + '.toml'), current.snapshot.text);
  state.pending = record;
  atomicJson(context.ledger, state);
  options.afterIntent?.(record);
  const now = readFile(context.file);
  if (now.hash !== record.beforeHash || !now.exists) throw new Error('Codex config changed after review; pending intent was retained');
  const components = ['mcp_servers', JSON.stringify(view.server), 'tools', JSON.stringify(view.tool), 'approval_mode'];
  const keyPath = components.slice(0, editLevel === 'tools' ? 3 : editLevel === 'tool' ? 4 : 5).join('.');
  const [written] = rpc([{ method: 'config/value/write', params: { filePath: context.file,
    expectedVersion: record.beforeVersion, keyPath, value: desiredValue, mergeStrategy: 'replace' } }], options, context);
  options.afterWrite?.(written);
  if (written?.status !== 'ok' || normalized(written.filePath || '') !== normalized(context.file)) {
    throw new Error('Codex did not confirm an effective exact config write; pending intent was retained');
  }
  return finishRecord(state, record, inspectInternal(options, context), context);
}

function applyCodexMcpApproval(request, options = {}) {
  const query = { ...options, server: request?.server, tool: request?.tool };
  const context = paths(query);
  assertReady(query);
  const state = load(context), inspected = inspectInternal(query, context);
  if (typeof request?.expectedFingerprint !== 'string' || request.expectedFingerprint !== inspected.view.fingerprint) {
    throw new Error('Codex MCP approval selection changed after review');
  }
  if (inspected.beforeApproval.exists && inspected.beforeApproval.value === 'approve') {
    return { changed: false, reason: 'The exact user-config approval is already present', server: query.server, tool: query.tool };
  }
  return performChange(inspected, 'approve', 'approve', null, query, context, state);
}

function restoreCodexMcpApproval(receiptId, options = {}) {
  const context = paths(options);
  assertReady(options);
  const state = load(context), receipt = state.receipts.find(record => record.id === receiptId && record.action === 'approve');
  if (!receipt || state.receipts.some(record => record.restores === receiptId)) throw new Error('Codex MCP receipt is missing or already restored');
  if (readFile(path.join(context.backups, receipt.id + '.toml')).hash !== receipt.beforeHash) {
    throw new Error('Codex MCP pre-change backup is missing or changed');
  }
  const query = { ...options, server: receipt.server, tool: receipt.tool };
  const inspected = inspectInternal(query, context);
  if (inspected.view.source.hash !== receipt.afterHash || inspected.view.source.version !== receipt.afterVersion ||
      inspected.beforeApproval.value !== 'approve') throw new Error('Codex config changed after this approval; restoration requires manual review');
  let editLevel = 'approval';
  const tools = inspected.current.user.config.mcp_servers[receipt.server].tools;
  // Remove only structures this approval introduced, through the native writer.
  // Existing empty tables and foreign tool metadata are not ours to remove.
  if (!receipt.beforeStructure.toolExists && Object.keys(tools[receipt.tool]).length === 1) {
    editLevel = !receipt.beforeStructure.toolsExists && Object.keys(tools).length === 1 ? 'tools' : 'tool';
  }
  return performChange(inspected, receipt.beforeApproval.exists ? receipt.beforeApproval.value : null,
    'restore', receipt.id, query, context, state, editLevel);
}

// Recovery never retries a policy write. The caller explicitly accepts current
// bytes; only an untouched before-state or the exact planned semantics can end
// the intent. Other edits leave the intent and backup available for review.
function finishPending(request, options = {}) {
  const context = paths(options), state = load(context), record = state.pending;
  if (!record || request?.id !== record.id) throw new Error('Codex MCP pending selection changed');
  const now = readFile(context.file);
  if (typeof request.acceptedHash !== 'string' || request.acceptedHash !== now.hash) throw new Error('Codex MCP recovery must accept the current exact config bytes');
  if (now.exists && now.hash === record.beforeHash) {
    state.pending = null; atomicJson(context.ledger, state);
    return { changed: false, cancelled: true, id: record.id };
  }
  const inspected = inspectInternal({ ...options, server: record.server, tool: record.tool }, context);
  if (inspected.view.source.hash !== request.acceptedHash) throw new Error('Codex config changed during recovery');
  return { ...finishRecord(state, record, inspected, context), recovered: true };
}

// nativeRpcAsync is exported for src/spawn-thread.js, which runs it on a thread.
module.exports = { inspectCodexMcpTool, planCodexMcpApproval, applyCodexMcpApproval,
  restoreCodexMcpApproval, listCodexMcpApprovals, inspectPending, assertReady, finishPending,
  readCodexConfigLayers, readCodexConfigLayersAsync, nativeRpcAsync };

if (require.main === module && process.argv[2] === '--rpc-worker') {
  const readline = require('node:readline');
  // A HOST THAT IS GONE CANNOT READ THE ANSWER, AND MUST NOT TAKE THE KILL WITH IT
  // (2026-10-14). Writing the answer to a host that has died is EPIPE, and an
  // unhandled 'error' on process.stdout is an uncaught exception: the worker died
  // on its own catch-block write, after the finally below had armed its kill and
  // before that fired, so a codex that never answers was left running with nothing
  // left to end it. Measured on Linux (node:22-alpine), host SIGKILLed: the worker
  // ran to its 25 s deadline and died there, and the hung stand-in codex was still
  // running 30 s after the host. With this listener the worker ends it and exits.
  for (const stream of [process.stdout, process.stderr]) stream.on('error', () => {});
  const running = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === 'EPERM'; } };
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 1024 * 1024) process.exit(1); });
  process.stdin.on('end', async () => {
    let child, reader, timeout, hostWatch, closed, closing = false, nextId = 0;
    // A read-only request with its own deadline also gets a short grace before
    // its app-server is tree-killed: there is no write to let finish, and the
    // caller's budget is counted in seconds. Every other request keeps 5 s.
    let deadlineAt = null, graceMs = 5000;
    const pending = new Map();
    try {
      const request = JSON.parse(input);
      if (!Array.isArray(request.requests) || request.requests.length > 4 || request.requests.some(item =>
        !['config/read', 'config/value/write'].includes(item?.method))) throw new Error('Unsupported config worker operation');
      if (Number.isFinite(request.deadlineAt)) {
        deadlineAt = request.deadlineAt;
        if (request.requests.every(item => item.method === 'config/read')) graceMs = 1000;
      }
      // An npm codex.cmd is run as the node script it names, so the app-server is
      // this worker's own child and in its job (exec-resolve's npmShimLaunch says
      // why); any other shape, the .cmd included, launches as before.
      const launch = npmShimLaunch(request.codexExecutable, ['app-server', '--stdio'])
        || commandLaunch(request.codexExecutable, ['app-server', '--stdio']);
      // ONE reason on every platform. commandLaunch resolves only on Windows; on
      // POSIX it hands the name back unchanged because spawn walks PATH itself, so
      // a missing executable surfaced as spawn's own ENOENT text instead and every
      // caller matching "not reachable" (the trusted-project fallback's blindSpots
      // note among them) read it as some other failure. Measured 2026-10-13: green
      // on Windows, red on both Ubuntu CI legs. A path-like name is checked here;
      // a bare name's spawn ENOENT is mapped below.
      const named = String(request.codexExecutable || '');
      const pathLike = named.includes('/') || named.includes('\\');
      if (!launch.resolved || (pathLike && !fs.existsSync(launch.file))) {
        throw new Error('Codex executable is not reachable');
      }
      const env = { ...process.env, HOME: request.home, USERPROFILE: request.home, CODEX_HOME: request.codexHome };
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
        'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']) delete env[key];
      // NOT detached, deliberately: the app-server stays in this worker's process
      // group, which nativeRpcAsync makes a group of its own on POSIX, so the
      // host's group signal (endProcessTree) ends it with the worker. A detached
      // app-server would lead a group of its own and escape that signal.
      // PAST ITS DEADLINE BEFORE IT STARTS ANYTHING (2026-10-14). Suppose this worker's own
      // start ran past `deadlineAt`, on a slow or busy machine. It used to spawn the
      // app-server anyway and fail the call the moment it armed the deadline. That put the
      // spawn, the app-server's start, the grace and the kill all inside the 3 s the host
      // leaves for the grace and the kill alone. Under load the backstop won: the masked
      // suite took 8.9 s of an 8 s budget, once. Now nothing is spawned only to be killed.
      if (deadlineAt !== null && Date.now() >= deadlineAt) throw new Error('Codex config operation timed out');
      child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true, cwd: request.home,
        env, stdio: ['pipe', 'pipe', 'pipe'] });
      closed = new Promise(resolve => child.once('close', resolve));
      const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
      child.once('error', error => fail(error?.code === 'ENOENT'
        ? new Error('Codex executable is not reachable') : error));
      child.once('exit', () => { if (!closing) fail(new Error('Codex config server exited early')); });
      child.stderr.resume();
      const send = message => child.stdin.write(JSON.stringify(message) + '\n');
      child.stdin.on('error', fail);
      const call = (method, params) => new Promise((resolve, reject) => {
        const id = ++nextId; pending.set(id, { resolve, reject }); send({ id, method, params });
      });
      reader = readline.createInterface({ input: child.stdout });
      reader.on('line', line => {
        try {
          const message = JSON.parse(line), waiting = pending.get(message.id);
          if (!waiting) return;
          pending.delete(message.id);
          if (message.error) waiting.reject(new Error(message.error.message || 'Codex config operation failed'));
          else waiting.resolve(message.result);
        } catch (error) { fail(error); }
      });
      // 25 s unless the caller set a deadline: the extension's read-only trust ask
      // does (nativeRpcAsync), so its whole budget, kill included, fits inside its
      // own backstop. It is a TIME, read here, after this worker's own start and
      // its codex spawn, so neither is taken from the margin the grace and the
      // kill need (see "THE DEADLINE IS A TIME" above). A worker that starts after
      // it has passed fails at once, which is still inside the backstop. Clamped,
      // so no request can lengthen the write path.
      const deadlineMs = deadlineAt === null ? 25000 : Math.min(25000, Math.max(0, deadlineAt - Date.now()));
      timeout = setTimeout(() => fail(new Error('Codex config operation timed out')), deadlineMs);
      // NOR WAIT OUT THAT DEADLINE FOR A HOST THAT IS GONE (2026-10-14). On POSIX
      // nothing ends a child when its parent dies, and nativeRpcAsync's worker
      // leads a process group and session of its own, so not even a signal to the
      // host's group reaches it. A dead parent shows here as a changed ppid (an
      // orphan is re-parented at once) or, where nothing re-parents, as a parent
      // that no longer runs. Either fails the call in flight, which ends the
      // app-server through the finally below the way the deadline would, within
      // half a second of the host's death instead of up to 25 s after it. On
      // Windows a Node host's libuv job object ends this worker with it, before
      // this can run, and this worker's job its app-server; what that leaves is in
      // test/codex-mcp-config.test.js ("a worker whose host dies outright").
      const parent = process.ppid;
      hostWatch = setInterval(() => {
        if (process.ppid === parent && running(parent)) return;
        fail(new Error('the process that started this worker is gone'));
      }, 500);
      hostWatch.unref();
      await call('initialize', { clientInfo: { name: 'acolyte_mcp_config', version: '1' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized', params: {} });
      const results = [];
      for (const item of request.requests) results.push(await call(item.method, item.params));
      process.stdout.write(JSON.stringify({ results }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: String(error.message).slice(0, 600) }));
      process.exitCode = 1;
    } finally {
      closing = true; clearTimeout(timeout); clearInterval(hostWatch);
      if (child) {
        child.stdin.end();
        // THE ONE TREE KILL (2026-10-14), src/exec-resolve.js's endProcessTree: System32's
        // taskkill /T on Windows (this worker inherits the host's cwd, so never a bare
        // name), and child.kill() on POSIX, where the app-server leads no group of its
        // own. Its guard reads `signalCode` as well as `exitCode`. This one read only
        // `exitCode`, and a child that exited by a signal has none, so the kill would
        // have gone to a PID the system may already have reused. Not reachable today:
        // on Windows `signalCode` is set only by this process's own child.kill(), which
        // the worker never calls there, and on POSIX child.kill() after 'exit' sends
        // nothing. One guard means the next change cannot make it reachable.
        const kill = setTimeout(() => { endProcessTree(child); }, graceMs);
        await closed; clearTimeout(kill);
      }
      reader?.close();
    }
  });
}
