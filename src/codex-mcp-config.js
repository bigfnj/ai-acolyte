'use strict';

// Exact reviewed MCP approval changes only. The caller must hold the shared
// policy lock across inspect/apply/restore/recovery and check assertReady before
// every other Codex policy writer. No thread or turn is started by this module.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { resolveCodexHome } = require('./codex-paths');
const { commandLaunch } = require('./exec-resolve');
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

module.exports = { inspectCodexMcpTool, planCodexMcpApproval, applyCodexMcpApproval,
  restoreCodexMcpApproval, listCodexMcpApprovals, inspectPending, assertReady, finishPending };

if (require.main === module && process.argv[2] === '--rpc-worker') {
  const readline = require('node:readline');
  const { spawn } = require('node:child_process');
  let input = '';
  process.stdin.setEncoding('utf8');
  process.stdin.on('data', chunk => { input += chunk; if (input.length > 1024 * 1024) process.exit(1); });
  process.stdin.on('end', async () => {
    let child, reader, timeout, closed, closing = false, nextId = 0;
    const pending = new Map();
    try {
      const request = JSON.parse(input);
      if (!Array.isArray(request.requests) || request.requests.length > 4 || request.requests.some(item =>
        !['config/read', 'config/value/write'].includes(item?.method))) throw new Error('Unsupported config worker operation');
      const launch = commandLaunch(request.codexExecutable, ['app-server', '--stdio']);
      if (!launch.resolved) throw new Error('Codex executable is not reachable');
      const env = { ...process.env, HOME: request.home, USERPROFILE: request.home, CODEX_HOME: request.codexHome };
      for (const key of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'CODEX_ACCESS_TOKEN', 'OPENAI_BASE_URL',
        'OPENAI_ORG_ID', 'OPENAI_ORGANIZATION', 'OPENAI_PROJECT_ID', 'AZURE_OPENAI_API_KEY', 'AZURE_OPENAI_ENDPOINT']) delete env[key];
      child = spawn(launch.file, launch.args, { ...launch.options, windowsHide: true, cwd: request.home,
        env, stdio: ['pipe', 'pipe', 'pipe'] });
      closed = new Promise(resolve => child.once('close', resolve));
      const fail = error => { for (const item of pending.values()) item.reject(error); pending.clear(); };
      child.once('error', fail);
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
      timeout = setTimeout(() => fail(new Error('Codex config operation timed out')), 25000);
      await call('initialize', { clientInfo: { name: 'acolyte_mcp_config', version: '1' }, capabilities: { experimentalApi: true } });
      send({ method: 'initialized', params: {} });
      const results = [];
      for (const item of request.requests) results.push(await call(item.method, item.params));
      process.stdout.write(JSON.stringify({ results }));
    } catch (error) {
      process.stdout.write(JSON.stringify({ error: String(error.message).slice(0, 600) }));
      process.exitCode = 1;
    } finally {
      closing = true; clearTimeout(timeout);
      if (child) {
        child.stdin.end();
        const kill = setTimeout(() => {
          if (child.exitCode !== null) return;
          if (process.platform === 'win32') spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
          else child.kill('SIGTERM');
        }, 5000);
        await closed; clearTimeout(kill);
      }
      reader?.close();
    }
  });
}
