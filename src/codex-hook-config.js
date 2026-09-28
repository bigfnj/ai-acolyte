'use strict';

// Pure hooks.json planning. Callers own file reads, stale-byte checks and atomic
// writes. Configuration does not confer trust: Codex must review the exact hook.
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const STATUS_MESSAGE = 'AI Acolyte: learn from completed Codex turns';
const object = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const posixQuote = (text) => "'" + text.replace(/'/g, "'\"'\"'") + "'";
const windowsQuote = (text) => "'" + text.replace(/'/g, "''") + "'";

function codexStopHookDefinition(options = {}) {
  const scriptPath = options.scriptPath === undefined ? path.join(__dirname, 'codex-stop-hook.js') : options.scriptPath;
  const nodeExecutable = options.nodeExecutable === undefined ? 'node' : options.nodeExecutable;
  if (typeof scriptPath !== 'string' || !path.isAbsolute(scriptPath) || /[\u0000-\u001f\u007f]/.test(scriptPath)) {
    throw new Error('Codex hook script must be an absolute path without control characters');
  }
  if (typeof nodeExecutable !== 'string' || !nodeExecutable || /[\u0000-\u001f\u007f]/.test(nodeExecutable)) {
    throw new Error('Codex hook Node executable must be a nonempty command or path without control characters');
  }
  return { hooks: [{ type: 'command', command: `${posixQuote(nodeExecutable)} ${posixQuote(scriptPath)}`,
    commandWindows: `& ${windowsQuote(nodeExecutable)} ${windowsQuote(scriptPath)}`,
    timeout: 30, statusMessage: STATUS_MESSAGE }] };
}

function inspectCodexStopHook(text, options = {}) {
  const group = codexStopHookDefinition(options);
  const expected = group.hooks[0];
  const result = { status: 'missing', configured: false, writable: true, trust: 'not-verified', reviewRequired: false, definition: group };
  if (options.readError) return { ...result, status: 'unreadable', writable: false, reason: String(options.readError.message || options.readError) };
  if (text === null || text === undefined) return result;
  let data;
  try { data = JSON.parse(text); }
  catch (error) { return { ...result, status: 'unsupported', writable: false, reason: `Cannot parse hooks.json: ${error.message}` }; }
  if (!object(data) || (data.hooks !== undefined && !object(data.hooks)) ||
      (data.hooks?.Stop !== undefined && !Array.isArray(data.hooks.Stop))) {
    return { ...result, status: 'unsupported', writable: false, reason: 'hooks.json must contain an object and an array for hooks.Stop' };
  }
  let count = 0;
  for (const entry of data.hooks?.Stop || []) {
    if (!object(entry) || !Array.isArray(entry.hooks) || entry.hooks.some((handler) => !object(handler))) {
      return { ...result, status: 'unsupported', writable: false, reason: 'Cannot safely inspect a malformed Stop hook group' };
    }
    for (const handler of entry.hooks) {
      if (isDeepStrictEqual(handler, expected)) { count++; continue; }
      if (handler.statusMessage === STATUS_MESSAGE || handler.command === expected.command || handler.commandWindows === expected.commandWindows) {
        return { ...result, status: 'changed-definition', writable: false,
          reason: 'The AI Acolyte Stop hook definition changed; review it before replacing or removing it' };
      }
    }
  }
  if (count > 1) return { ...result, status: 'changed-definition', writable: false, reason: 'Multiple AI Acolyte Stop hooks make ownership ambiguous' };
  return count === 1 ? { ...result, status: 'configured', configured: true, reviewRequired: true } : result;
}

function mergeCodexStopHook(text, enabled, options = {}) {
  if (typeof enabled !== 'boolean') throw new Error('Codex hook enabled state must be a boolean');
  const before = inspectCodexStopHook(text, options);
  if (!before.writable) throw new Error(`Refusing to change Codex hooks: ${before.reason}`);
  if (before.configured === enabled) return { ...before, changed: false, text };
  const data = text == null ? {} : JSON.parse(text);
  if (enabled) {
    if (!data.hooks) data.hooks = {};
    if (!data.hooks.Stop) data.hooks.Stop = [];
    data.hooks.Stop.push(before.definition);
  } else {
    const expected = before.definition.hooks[0];
    data.hooks.Stop = data.hooks.Stop.flatMap((entry) => {
      const hooks = entry.hooks.filter((handler) => !isDeepStrictEqual(handler, expected));
      if (hooks.length === entry.hooks.length) return [entry];
      // Drop only the empty group this writer created. Foreign group metadata
      // and unrelated handlers survive even when they share our group.
      return hooks.length || Object.keys(entry).some((key) => key !== 'hooks') ? [{ ...entry, hooks }] : [];
    });
  }
  const newline = typeof text === 'string' && text.includes('\r\n') ? '\r\n' : '\n';
  const next = JSON.stringify(data, null, 2).replace(/\n/g, newline) + newline;
  return { ...inspectCodexStopHook(next, options), changed: true, text: next };
}

module.exports = { codexStopHookDefinition, inspectCodexStopHook, mergeCodexStopHook };
