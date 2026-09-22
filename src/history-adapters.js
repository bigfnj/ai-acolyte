'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const SHELL_TOOLS = new Set(['Bash', 'PowerShell']);
const { isLearnableTool, toolTarget, toolPath } = require('./tool-learn');
const CODEX_ITEM_TYPES = new Set([
  'function_call', 'function_call_output', 'custom_tool_call', 'custom_tool_call_output',
]);
const DEFAULT_OVERLAP_BYTES = 256 * 1024;
const FINGERPRINT_BYTES = 4096;
// `fs.readSync`'s length argument is an int32, so ONE call asking for more than
// 2 GiB wraps negative and throws with a message that names the wrapped value
// rather than the problem. MEASURED 2026-09-22 against a 2,266,973,030-byte
// Codex transcript on this box: `Received -2027994266`. The loop in `readRange`
// was already there; this is the cap that lets it do its job.
const READ_CHUNK_BYTES = 64 * 1024 * 1024;
// The most one scan will ingest from ONE file. A transcript that has grown by
// more than this catches up over consecutive scans rather than blocking a whole
// tick on gigabytes, and the cursor advances to exactly what was consumed, so
// nothing is skipped and the next scan resumes at a record boundary.
const DEFAULT_INGEST_BYTES = 64 * 1024 * 1024;
// A slice cut at the ingest cap has to end on a newline or a record would be
// halved. Where the cap lands mid-record we widen looking for a boundary, and
// this is where widening stops: past here the file has no usable boundary and
// is reported rather than guessed at.
const INGEST_HARD_MAX_BYTES = 256 * 1024 * 1024;
// How far back the reconcile will widen looking for a tool call whose result
// landed after the cursor. It used to re-read the whole file, which is what
// made a 2 GiB transcript cost 570 ms of every tick without ever finishing.
const RECONCILE_MAX_BYTES = 64 * 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function firstDefined(...values) {
  return values.find((value) => value !== undefined && value !== null && value !== '');
}

function stringValue(value) {
  if (typeof value === 'string' && value) return value;
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

function stableHash(...parts) {
  const hash = crypto.createHash('sha256');
  for (const part of parts) {
    hash.update(String(part === undefined ? '' : part));
    hash.update('\0');
  }
  return hash.digest('hex').slice(0, 24);
}

function defineParserOffsets(observation, callOffset, callEnd) {
  Object.defineProperties(observation, {
    _callOffset: { value: callOffset, enumerable: false },
    _callEnd: { value: callEnd, enumerable: false },
    _resultOffset: { value: undefined, writable: true, enumerable: false },
    _resultEnd: { value: undefined, writable: true, enumerable: false },
  });
}

// A file or fetch path is tested against managed policy here and then dropped;
// what survives is the RULE it matched, which is org policy rather than user
// data. Putting the path on the observation instead would have downgraded the
// invariant from "no path ever leaves the parser", which one assertion can
// check, to "no path is ever persisted", which every future consumer has to
// keep true. The matcher is injected so this module stays policy-ignorant, and
// a throwing or absent matcher simply yields no rule.
function matchManaged(options, tool, filePath) {
  const matcher = options && typeof options.probeMatcher === 'function'
    ? options.probeMatcher : null;
  if (!matcher || !filePath) return undefined;
  try {
    const rule = matcher(String(tool), String(filePath));
    return typeof rule === 'string' && rule ? rule : undefined;
  } catch { return undefined; }
}

function createObservation(fields) {
  const { source, tool, command } = fields;
  // A non-shell tool carries an opaque target rather than a command string.
  const kind = SHELL_TOOLS.has(tool) ? 'shell' : 'tool';
  if (kind === 'tool' && !isLearnableTool(tool)) return null;
  if (typeof command !== 'string' || !command.trim()) return null;
  const locationKey = fields.file || '<text>';
  const realCallId = stringValue(fields.callId);
  const effectiveCallId = realCallId || `${source}-synthetic-${stableHash(
    locationKey, fields.session, fields.callOffset, fields.commandIndex || 0, command,
  )}`;
  const identityParts = realCallId
    ? [source, fields.session, realCallId, fields.commandIndex || 0]
    : [source, locationKey, fields.session, effectiveCallId, fields.commandIndex || 0, command];
  const observation = {
    id: `${source}:${stableHash(...identityParts)}`,
    source,
    tool,
    command,
    status: 'unknown',
    callId: effectiveCallId,
  };
  if (kind === 'tool') observation.kind = kind;
  // The managed RULE a non-shell call matched, never the path that matched it.
  // Deliberately absent from `identityParts` above so existing observation
  // hashes do not move: adding this must not re-observe a counted corpus.
  if (fields.managedRule !== undefined) observation.managedRule = fields.managedRule;
  if (fields.timestamp !== undefined) observation.timestamp = fields.timestamp;
  if (fields.cwd !== undefined) observation.cwd = fields.cwd;
  if (fields.session !== undefined) observation.session = fields.session;
  defineParserOffsets(observation, fields.callOffset, fields.callEnd);
  return observation;
}

function mergeStatus(current, incoming) {
  if (incoming === 'failed') return 'failed';
  if (incoming === 'success' && current !== 'failed') return 'success';
  return current || 'unknown';
}

function applyResult(observation, result) {
  if (!observation || !result) return;
  observation.status = mergeStatus(observation.status, result.status);
  if (result.offset !== undefined) observation._resultOffset = result.offset;
  if (result.end !== undefined) observation._resultEnd = result.end;
}

// Offsets are byte-based so an append scanner can compare them with fs.stat.
//
// The split is on the newline BYTE rather than on a decoded string, because a
// decoded line no longer knows how many bytes it came from, and recovering that
// with `Buffer.byteLength` per line was 26% of this function's self time: 90.8
// -> 60.1 ms over a 19.5 MB corpus. Byte 10 and byte 13 cannot appear inside a
// multi-byte UTF-8 sequence, so slicing on them is decode-safe. A string caller
// is encoded once here rather than given a second code path, so the offsets
// stay byte-exact whichever way the parser is entered.
function parseJsonlRecords(text, options, onRecord) {
  const source = Buffer.isBuffer(text) ? text : Buffer.from(String(text == null ? '' : text), 'utf8');
  const baseOffset = Number.isFinite(options && options.baseOffset) ? options.baseOffset : 0;
  let offset = baseOffset;
  let start = 0;
  let index = 0;
  for (;;) {
    const newline = source.indexOf(10, start);
    const lineEnd = newline === -1 ? source.length : newline;
    const byteLength = (lineEnd - start) + (newline === -1 ? 0 : 1);
    const location = { offset, end: offset + byteLength, index };
    offset += byteLength;
    index += 1;
    const textEnd = lineEnd > start && source[lineEnd - 1] === 13 ? lineEnd - 1 : lineEnd;
    if (textEnd > start) {
      const line = source.toString('utf8', start, textEnd);
      if (line.trim()) {
        let record;
        try { record = JSON.parse(line); } catch { record = undefined; }
        if (isObject(record)) onRecord(record, location);
      }
    }
    if (newline === -1) break;
    start = newline + 1;
  }
}

function walkObjectBlocks(value, visitor, depth = 0) {
  if (depth > 20 || value === null || typeof value !== 'object') return;
  if (Array.isArray(value)) {
    for (const entry of value) walkObjectBlocks(entry, visitor, depth + 1);
    return;
  }
  visitor(value);
  for (const child of Object.values(value)) {
    if (child !== null && typeof child === 'object') walkObjectBlocks(child, visitor, depth + 1);
  }
}

function numericExitCode(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && /^-?\d+$/.test(value.trim())) return Number(value.trim());
  return undefined;
}

// Codex reports how a script went in words even when it reports no exit code,
// and that wording was the single largest source of discarded evidence: an
// `unknown` outcome is dropped as not-evidence without even a stored
// observation hash. Measured on this machine's Codex corpus, 60 recent session
// files and 4,259 tool outputs: 2,316 resolved by an exit code, and **854**
// carried only this wording, which is 27% of everything resolvable.
//
// Treating `completed` as success is an inference, so it was checked rather
// than assumed. Across every output where BOTH the wording and an exit code
// appear, `completed` coincided with exit 0 thirteen times and with a nonzero
// code **zero** times. Note that `test/history-adapters.test.js` deliberately
// fixtures `Script completed` alongside `Exit code: 1`; that combination did
// not occur in the corpus, and it does not matter here regardless, because
// every caller checks for an explicit code first and only falls back to this.
function scriptWordingStatus(value) {
  const match = /\bScript\s+(completed|failed)\b/i.exec(value);
  if (!match) return 'unknown';
  return match[1].toLowerCase() === 'completed' ? 'success' : 'failed';
}

function structuredResultStatus(value, options = {}, depth = 0, seen = new Set()) {
  if (depth > 8 || value === null || value === undefined) return 'unknown';
  if (typeof value === 'string') {
    if (!options.inspectText) return 'unknown';
    const patterns = [
      /\bprocess\s+exited\s+with\s+(?:exit\s+)?code\s*:?\s*(-?\d+)\b/i,
      /\bexit(?:ed)?\s+(?:with\s+)?code\s*[:=]\s*(-?\d+)\b/i,
      /\bexit_code\s*[:=]\s*(-?\d+)\b/i,
      // The quote class was `[']`, a one-member class holding only an
      // apostrophe, where `['"]` was meant. So the double-quoted spelling that
      // `JSON.stringify` produces matched none of these, and the bare
      // `exit_code` pattern above cannot cover it either, because the closing
      // quote sits between the key and the colon and `\s*` will not consume
      // it. Measured: 43 outputs in the local corpus carry the quoted form.
      /['"]exit_code['"]\s*:\s*(-?\d+)\b/i,
      /['"]exitCode['"]\s*:\s*(-?\d+)\b/i,
    ];
    for (const pattern of patterns) {
      const match = pattern.exec(value);
      if (match) return Number(match[1]) === 0 ? 'success' : 'failed';
    }
    // An explicit code always wins; this is only reached when there is none.
    return scriptWordingStatus(value);
  }
  if (!isObject(value) && !Array.isArray(value)) return 'unknown';
  if (seen.has(value)) return 'unknown';
  seen.add(value);
  if (Array.isArray(value)) {
    let status = 'unknown';
    for (const entry of value) {
      status = mergeStatus(status, structuredResultStatus(entry, options, depth + 1, seen));
    }
    return status;
  }
  const failureFlags = ['is_error', 'isError', 'failed', 'interrupted', 'timed_out', 'timedOut'];
  if (failureFlags.some((key) => value[key] === true)) return 'failed';
  if (value.success === false || value.ok === false) return 'failed';
  for (const key of ['exit_code', 'exitCode', 'status_code', 'statusCode', 'returncode', 'returnCode']) {
    const code = numericExitCode(value[key]);
    if (code !== undefined) return code === 0 ? 'success' : 'failed';
  }
  const statusWord = typeof value.status === 'string' ? value.status.toLowerCase() : '';
  if (['failed', 'failure', 'error', 'errored', 'cancelled', 'canceled', 'timed_out'].includes(statusWord)) {
    return 'failed';
  }
  if (value.success === true || value.ok === true || ['success', 'succeeded'].includes(statusWord)) {
    return 'success';
  }
  let status = 'unknown';
  for (const [key, child] of Object.entries(value)) {
    const inspectText = options.inspectText && ['output', 'text', 'content', 'message', 'result'].includes(key);
    if ((child !== null && typeof child === 'object') || (inspectText && typeof child === 'string')) {
      status = mergeStatus(status, structuredResultStatus(child, options, depth + 1, seen));
    }
  }
  return status;
}

function claudeMessageCandidates(record) {
  const candidates = [];
  const add = (value) => {
    if (isObject(value) && !candidates.includes(value)) candidates.push(value);
  };
  add(record.message);
  add(record.payload && record.payload.message);
  if (record.role || Array.isArray(record.content)) add(record);
  return candidates;
}

function claudeMetadata(record, message, state, options) {
  const payload = isObject(record.payload) ? record.payload : {};
  return {
    session: firstDefined(
      stringValue(record.sessionId), stringValue(record.session_id),
      stringValue(payload.sessionId), stringValue(payload.session_id),
      state.session, stringValue(options.session),
    ),
    cwd: firstDefined(
      stringValue(record.cwd), stringValue(payload.cwd), stringValue(message && message.cwd),
      state.cwd, stringValue(options.cwd),
    ),
    timestamp: firstDefined(record.timestamp, payload.timestamp, message && message.timestamp),
  };
}

function classifyClaudeResult(block, supplement) {
  if (block && (block.is_error === true || block.isError === true)) return 'failed';
  const structured = structuredResultStatus(supplement, { inspectText: false });
  if (structured !== 'unknown') return structured;
  if (block && (block.is_error === false || block.isError === false)) return 'success';
  // tool_result/toolUseResult is written only after execution. Explicit errors
  // above still win; otherwise its presence is Claude's completion signal.
  if (block || supplement !== undefined) return 'success';
  return 'unknown';
}

function parseClaudeJsonl(text, options = {}) {
  const observations = [];
  const calls = new Map();
  const results = new Map();
  const state = { session: stringValue(options.session), cwd: stringValue(options.cwd) };
  const file = stringValue(options.file) || stringValue(options.path);

  parseJsonlRecords(text, options, (record, location) => {
    const payload = isObject(record.payload) ? record.payload : {};
    state.session = firstDefined(
      stringValue(record.sessionId), stringValue(record.session_id),
      record.type === 'session_meta' ? stringValue(payload.id) : undefined, state.session,
    );
    state.cwd = firstDefined(stringValue(record.cwd), stringValue(payload.cwd), state.cwd);

    const messages = claudeMessageCandidates(record);
    for (const message of messages) {
      const role = String(firstDefined(message.role, message.type, record.type, '')).toLowerCase();
      const isAssistant = role === 'assistant' || String(record.type || '').toLowerCase() === 'assistant';
      if (!isAssistant || !Array.isArray(message.content)) continue;
      let blockIndex = 0;
      walkObjectBlocks(message.content, (block) => {
        if (block.type !== 'tool_use') return;
        const shell = SHELL_TOOLS.has(block.name);
        if (!shell && !isLearnableTool(block.name)) return;
        const metadata = claudeMetadata(record, message, state, options);
        const observation = createObservation({
          source: 'claude',
          tool: block.name,
          command: shell ? (block.input && block.input.command)
            : toolTarget(block.name, block.input),
          managedRule: shell ? undefined
            : matchManaged(options, block.name, toolPath(block.name, block.input)),
          callId: firstDefined(block.id, block.tool_use_id, block.toolUseId, block.call_id, block.callId),
          timestamp: metadata.timestamp,
          cwd: metadata.cwd,
          session: metadata.session,
          file,
          callOffset: location.offset,
          callEnd: location.end,
          commandIndex: blockIndex,
        });
        blockIndex += 1;
        if (!observation) return;
        const key = `${observation.callId}\0${observation.command}`;
        if (calls.has(key)) return;
        calls.set(key, observation);
        observations.push(observation);
        const priorResult = results.get(observation.callId);
        if (priorResult) applyResult(observation, priorResult);
      });
    }

    const recordSupplement = firstDefined(record.toolUseResult, payload.toolUseResult);
    const resultBlocks = [];
    for (const message of messages) {
      if (!Array.isArray(message.content)) continue;
      walkObjectBlocks(message.content, (block) => {
        if (block.type === 'tool_result') resultBlocks.push(block);
      });
    }
    if (record.type === 'tool_result') resultBlocks.push(record);

    for (const block of resultBlocks) {
      const callId = stringValue(firstDefined(
        block.tool_use_id, block.toolUseId, block.call_id, block.callId,
        record.tool_use_id, record.toolUseId,
      ));
      if (!callId) continue;
      const result = {
        status: classifyClaudeResult(block, firstDefined(block.toolUseResult, recordSupplement)),
        offset: location.offset,
        end: location.end,
      };
      const previous = results.get(callId);
      if (previous) result.status = mergeStatus(previous.status, result.status);
      results.set(callId, result);
      for (const observation of calls.values()) {
        if (observation.callId === callId) applyResult(observation, result);
      }
    }

    // Some versions use a keyed, direct toolUseResult without a content block.
    if (recordSupplement !== undefined && resultBlocks.length === 0) {
      const resultObject = isObject(recordSupplement) ? recordSupplement : {};
      const callId = stringValue(firstDefined(
        resultObject.tool_use_id, resultObject.toolUseId, resultObject.call_id,
        resultObject.callId, record.tool_use_id, record.toolUseId,
      ));
      if (callId) {
        const result = {
          status: classifyClaudeResult(undefined, recordSupplement),
          offset: location.offset,
          end: location.end,
        };
        results.set(callId, result);
        for (const observation of calls.values()) {
          if (observation.callId === callId) applyResult(observation, result);
        }
      }
    }
  });
  return observations;
}

function isIdentifierStart(char) {
  return typeof char === 'string' && /[A-Za-z_$]/.test(char);
}

function isIdentifierPart(char) {
  return typeof char === 'string' && /[A-Za-z0-9_$]/.test(char);
}

function readIdentifier(source, start) {
  if (!isIdentifierStart(source[start])) return null;
  let end = start + 1;
  while (end < source.length && isIdentifierPart(source[end])) end += 1;
  return { value: source.slice(start, end), end };
}

function skipTrivia(source, start) {
  let index = start;
  while (index < source.length) {
    if (/\s/.test(source[index])) { index += 1; continue; }
    if (source[index] === '/' && source[index + 1] === '/') {
      const newline = source.indexOf('\n', index + 2);
      return newline === -1 ? source.length : skipTrivia(source, newline + 1);
    }
    if (source[index] === '/' && source[index + 1] === '*') {
      const close = source.indexOf('*/', index + 2);
      return close === -1 ? source.length : skipTrivia(source, close + 2);
    }
    break;
  }
  return index;
}

function readJsStringLiteral(source, start) {
  const quote = source[start];
  const quoteCode = quote && quote.charCodeAt(0);
  const slash = String.fromCharCode(92);
  if (![34, 39, 96].includes(quoteCode)) return null;
  let value = '';
  let valid = true;
  let index = start + 1;
  while (index < source.length) {
    const char = source[index];
    if (char === quote) return { value: valid ? value : undefined, valid, end: index + 1 };
    if (quoteCode === 96 && char === '$' && source[index + 1] === '{') valid = false;
    if (char !== slash) { value += char; index += 1; continue; }
    index += 1;
    if (index >= source.length) break;
    const escaped = source[index];
    const simpleCodes = { b: 8, f: 12, n: 10, r: 13, t: 9, v: 11, 0: 0 };
    if (Object.prototype.hasOwnProperty.call(simpleCodes, escaped)) {
      value += String.fromCharCode(simpleCodes[escaped]);
      index += 1;
    } else if (escaped.charCodeAt(0) === 10) {
      index += 1;
    } else if (escaped.charCodeAt(0) === 13) {
      index += source.charCodeAt(index + 1) === 10 ? 2 : 1;
    } else if (escaped === 'x' || escaped === 'u') {
      const length = escaped === 'x' ? 2 : 4;
      const hex = source.slice(index + 1, index + 1 + length);
      if (!new RegExp('^[0-9A-Fa-f]{' + length + '}$').test(hex)) valid = false;
      else value += String.fromCharCode(parseInt(hex, 16));
      index += 1 + length;
    } else {
      value += escaped;
      index += 1;
    }
  }
  return { value: undefined, valid: false, end: source.length };
}

function isQuote(char) {
  return typeof char === 'string' && [34, 39, 96].includes(char.charCodeAt(0));
}

function findCommandProperty(source, objectStart) {
  let index = objectStart + 1;
  let curly = 1;
  let paren = 0;
  let bracket = 0;
  let atPropertyStart = true;
  while (index < source.length && curly > 0) {
    index = skipTrivia(source, index);
    if (index >= source.length) break;
    const char = source[index];
    if (curly === 1 && paren === 0 && bracket === 0 && atPropertyStart) {
      let key;
      let keyEnd = index;
      if (isQuote(char) && char.charCodeAt(0) !== 96) {
        const literal = readJsStringLiteral(source, index);
        if (!literal) return null;
        key = literal.valid ? literal.value : undefined;
        keyEnd = literal.end;
      } else {
        const identifier = readIdentifier(source, index);
        if (identifier) { key = identifier.value; keyEnd = identifier.end; }
      }
      if (key !== undefined) {
        const colon = skipTrivia(source, keyEnd);
        if (source[colon] === ':') {
          const valueStart = skipTrivia(source, colon + 1);
          if (NESTED_COMMAND_KEYS.has(key) && isQuote(source[valueStart])) {
            const literal = readJsStringLiteral(source, valueStart);
            if (!literal || !literal.valid) return null;
            const afterValue = skipTrivia(source, literal.end);
            return (source[afterValue] === ',' || source[afterValue] === '}') ? literal.value : null;
          }
          index = valueStart;
          atPropertyStart = false;
          continue;
        }
      }
      atPropertyStart = false;
    }
    if (isQuote(char)) {
      const literal = readJsStringLiteral(source, index);
      index = literal ? literal.end : source.length;
      continue;
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipTrivia(source, index);
      continue;
    }
    if (char === '{') curly += 1;
    else if (char === '}') curly -= 1;
    else if (char === '(') paren += 1;
    else if (char === ')') paren = Math.max(0, paren - 1);
    else if (char === '[') bracket += 1;
    else if (char === ']') bracket = Math.max(0, bracket - 1);
    else if (char === ',' && curly === 1 && paren === 0 && bracket === 0) atPropertyStart = true;
    index += 1;
  }
  return null;
}

// Tiny lexer for the generated functions.exec shape. It never evaluates JS;
// variables, concatenation, interpolation, and computed properties are rejected.
//
// Codex has shipped two names for the nested shell entry point, and
// `src/auto-learn.js` already knows both (COMMAND_TOOLS, :8-11). This module
// knew only the older one, so a 0.153.x rollout — whose generated body calls
// `tools.exec_command({ cmd: "..." })` — extracted nothing, and since the
// extractor is the only way a `custom_tool_call` becomes an observation, the
// whole Codex corpus produced ZERO observations in every mode. Verified on a
// real rollout, and silent: an empty command list is indistinguishable here
// from a script that ran no shell at all.
//
// The two names spell the command differently (`command` vs `cmd`), and both
// spellings are accepted for both names on purpose. An accepted spelling that
// never occurs costs one set lookup; a missing one costs the entire corpus, as
// above, with no error anywhere to say so.
const NESTED_SHELL_METHODS = new Set(['shell_command', 'exec_command']);
const NESTED_COMMAND_KEYS = new Set(['command', 'cmd']);
// The same two names again, for the NON-nested shape: a plain `function_call`
// carrying the command in its arguments rather than a generated script that
// calls `tools.exec_command(...)`. `src/auto-learn.js:8-11` has known both
// names for as long as the nested extractor has; this reader knew only
// `shell_command`, so a rollout emitting `exec_command` directly yielded no
// observation at all and looked exactly like a session that ran no shell.
//
// NOT VERIFIED AGAINST A REAL SAMPLE. No transcript on this machine carries the
// non-nested `exec_command` shape, so the argument key is accepted in both
// spellings the nested form is known to use, and nothing else about the record
// is assumed. An accepted name that never occurs costs one set lookup; a
// missing one costs the whole corpus, silently, which is the trade the nested
// extractor already made for the same reason.
const CODEX_FUNCTION_SHELL_NAMES = new Set([
  'shell_command', 'functions.shell_command', 'exec_command', 'functions.exec_command',
]);
const NESTED_SHELL_CALL_RE = new RegExp(
  `\\btools\\s*\\.\\s*(?:${[...NESTED_SHELL_METHODS].join('|')})\\s*\\(`,
);

function extractNestedShellCommands(jsSource) {
  const source = typeof jsSource === 'string' ? jsSource : '';
  const commands = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (isQuote(char)) {
      const literal = readJsStringLiteral(source, index);
      index = literal ? literal.end : source.length;
      continue;
    }
    if (char === '/' && (source[index + 1] === '/' || source[index + 1] === '*')) {
      index = skipTrivia(source, index);
      continue;
    }
    const toolsIdentifier = readIdentifier(source, index);
    if (!toolsIdentifier || toolsIdentifier.value !== 'tools') {
      index += toolsIdentifier ? toolsIdentifier.value.length : 1;
      continue;
    }
    let cursor = skipTrivia(source, toolsIdentifier.end);
    if (source[cursor] !== '.') { index = toolsIdentifier.end; continue; }
    cursor = skipTrivia(source, cursor + 1);
    const method = readIdentifier(source, cursor);
    if (!method || !NESTED_SHELL_METHODS.has(method.value)) { index = toolsIdentifier.end; continue; }
    cursor = skipTrivia(source, method.end);
    if (source[cursor] !== '(') { index = method.end; continue; }
    cursor = skipTrivia(source, cursor + 1);
    if (source[cursor] !== '{') { index = cursor; continue; }
    const command = findCommandProperty(source, cursor);
    if (typeof command === 'string' && command.trim()) commands.push(command);
    index = cursor + 1;
  }
  return commands;
}

function maskJsCode(source) {
  const text = String(source || '');
  const masked = text.split('');
  let index = 0;
  while (index < text.length) {
    if (isQuote(text[index])) {
      const literal = readJsStringLiteral(text, index);
      const end = literal ? literal.end : text.length;
      for (let cursor = index; cursor < end; cursor++) masked[cursor] = ' ';
      index = end;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '/') {
      const newline = text.indexOf('\n', index + 2);
      const end = newline === -1 ? text.length : newline;
      for (let cursor = index; cursor < end; cursor++) masked[cursor] = ' ';
      index = end;
      continue;
    }
    if (text[index] === '/' && text[index + 1] === '*') {
      const close = text.indexOf('*/', index + 2);
      const end = close === -1 ? text.length : close + 2;
      for (let cursor = index; cursor < end; cursor++) masked[cursor] = ' ';
      index = end;
      continue;
    }
    index += 1;
  }
  return masked.join('');
}

function customExecCanAttributeSuccess(jsSource, commands) {
  if (!Array.isArray(commands) || commands.length !== 1) return false;
  const code = maskJsCode(jsSource);
  if (/\b(?:catch|class|do|else|exit|finally|for|function|if|switch|try|while|with)\b|&&|\|\||=>|\?/.test(code)) {
    return false;
  }
  // Both nested names, for the reason given at NESTED_SHELL_METHODS. Teaching
  // the extractor alone would have surfaced the calls with success permanently
  // unattributable, so `counts.success` would stay at zero and auto-safe would
  // still never fire on a Codex-only corpus.
  const call = NESTED_SHELL_CALL_RE.exec(code);
  if (!call || !/\bawait\s*$/.test(code.slice(0, call.index))) return false;
  let curlyDepth = 0;
  for (let index = 0; index < call.index; index++) {
    if (code[index] === '{') curlyDepth += 1;
    else if (code[index] === '}') curlyDepth = Math.max(0, curlyDepth - 1);
  }
  return curlyDepth === 0;
}

// Exit-code lines if there are any, otherwise Codex's wording. Deliberately a
// whole-payload fallback rather than a per-string one, because a single
// execution emits BOTH a `Script completed` summary and an `Output:` block
// carrying `Exit code: 0`. Collecting from each string independently pushed two
// statuses for one command, and the attribution logic then refused the pair as
// a count mismatch, which is the right call on wrong input. Evidence is only
// added where there was none.
function nestedShellStatuses(value) {
  const codes = explicitNestedShellStatuses(value);
  if (codes.length) return codes;
  return scriptWordingStatuses(value);
}

function scriptWordingStatuses(value, statuses = [], depth = 0) {
  if (depth > 8 || value == null) return statuses;
  if (typeof value === 'string') {
    const status = scriptWordingStatus(value);
    if (status !== 'unknown') statuses.push(status);
    return statuses;
  }
  if (Array.isArray(value)) {
    for (const item of value) scriptWordingStatuses(item, statuses, depth + 1);
    return statuses;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) scriptWordingStatuses(child, statuses, depth + 1);
  }
  return statuses;
}

function explicitNestedShellStatuses(value, statuses = [], depth = 0) {
  if (depth > 8 || value == null) return statuses;
  if (typeof value === 'string') {
    const match = /(?:^|\r?\n)\s*Exit code:\s*(-?\d+)\b/i.exec(value);
    if (match) statuses.push(Number(match[1]) === 0 ? 'success' : 'failed');
    return statuses;
  }
  if (Array.isArray(value)) {
    for (const item of value) explicitNestedShellStatuses(item, statuses, depth + 1);
    return statuses;
  }
  if (isObject(value)) {
    for (const child of Object.values(value)) explicitNestedShellStatuses(child, statuses, depth + 1);
  }
  return statuses;
}

function jsonObject(value) {
  if (isObject(value)) return value;
  if (typeof value !== 'string') return null;
  try {
    const parsed = JSON.parse(value);
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function codexItems(record) {
  const items = [];
  const add = (item) => {
    if (isObject(item) && CODEX_ITEM_TYPES.has(item.type) && !items.includes(item)) items.push(item);
  };
  if (record.type === 'response_item') add(record.payload);
  add(record);
  add(record.payload);
  add(record.item);
  if (isObject(record.payload)) add(record.payload.item);
  return items;
}

function codexTool(options) {
  if (SHELL_TOOLS.has(options.tool)) return options.tool;
  if (SHELL_TOOLS.has(options.defaultTool)) return options.defaultTool;
  return (options.platform || process.platform) === 'win32' ? 'PowerShell' : 'Bash';
}

function classifyCodexOutput(item) {
  return structuredResultStatus(item, { inspectText: true });
}

function applyCodexGroupResult(group, result) {
  if (!Array.isArray(group) || group.length === 0 || !result) return;
  let effectiveResult = result;
  if (group._customExec) {
    const nested = Array.isArray(result.nestedStatuses) ? result.nestedStatuses : [];
    let status = 'unknown';
    if (result.status === 'failed' || nested.includes('failed')) status = 'failed';
    else if (group._canAttributeSuccess && group.length === 1 &&
        nested.length === 1 && nested[0] === 'success') status = 'success';
    effectiveResult = { ...result, status };
  } else if (group.length > 1 && result.status !== 'failed') {
    effectiveResult = { ...result, status: 'unknown' };
  }
  for (const observation of group) applyResult(observation, effectiveResult);
}

// Codex writes `cwd` and the session id in the head-of-file `session_meta`
// record and nowhere else, so the same few lines have to serve both the
// in-order parse and the head-only seed read below.
function applyCodexSessionState(record, state) {
  const payload = isObject(record.payload) ? record.payload : {};
  if (record.type === 'session_meta') {
    state.session = firstDefined(stringValue(payload.id), stringValue(payload.session_id), state.session);
    state.cwd = firstDefined(stringValue(payload.cwd), state.cwd);
  }
  state.session = firstDefined(stringValue(record.sessionId), stringValue(record.session_id), state.session);
  state.cwd = firstDefined(stringValue(record.cwd), state.cwd);
  return state;
}

function parseCodexJsonl(text, options = {}) {
  const observations = [];
  const callGroups = new Map();
  const results = new Map();
  const state = { session: stringValue(options.session), cwd: stringValue(options.cwd) };
  const file = stringValue(options.file) || stringValue(options.path);
  const tool = codexTool(options);

  parseJsonlRecords(text, options, (record, location) => {
    const payload = isObject(record.payload) ? record.payload : {};
    applyCodexSessionState(record, state);

    for (const item of codexItems(record)) {
      if (item.type === 'function_call') {
        const name = String(item.name || '');
        if (!CODEX_FUNCTION_SHELL_NAMES.has(name)) continue;
        const args = jsonObject(item.arguments) || jsonObject(item.input);
        const commandText = args && typeof args.command === 'string' ? args.command
          : args && typeof args.cmd === 'string' ? args.cmd : '';
        if (!commandText.trim()) continue;
        const outerCallId = stringValue(firstDefined(item.call_id, item.callId, item.id));
        const observation = createObservation({
          source: 'codex', tool, command: commandText, callId: outerCallId,
          timestamp: firstDefined(record.timestamp, payload.timestamp, item.timestamp),
          cwd: firstDefined(stringValue(args.workdir), state.cwd), session: state.session,
          file, callOffset: location.offset, callEnd: location.end,
        });
        if (!observation) continue;
        const groupKey = outerCallId || observation.callId;
        if (!callGroups.has(groupKey)) callGroups.set(groupKey, []);
        const group = callGroups.get(groupKey);
        if (!group.some((entry) => entry.id === observation.id)) {
          group.push(observation);
          observations.push(observation);
        }
        if (results.has(groupKey)) applyCodexGroupResult(group, results.get(groupKey));
        continue;
      }

      if (item.type === 'custom_tool_call') {
        const name = String(item.name || '');
        if (name !== 'exec' && name !== 'functions.exec') continue;
        const input = typeof item.input === 'string'
          ? item.input
          : (typeof item.arguments === 'string' ? item.arguments : '');
        const commands = extractNestedShellCommands(input);
        const outerCallId = stringValue(firstDefined(item.call_id, item.callId, item.id));
        const groupKey = outerCallId || `codex-group-${stableHash(file, state.session, location.offset, input)}`;
        if (!callGroups.has(groupKey)) callGroups.set(groupKey, []);
        const group = callGroups.get(groupKey);
        group._customExec = true;
        group._canAttributeSuccess = customExecCanAttributeSuccess(input, commands);
        commands.forEach((command, commandIndex) => {
          const observation = createObservation({
            source: 'codex', tool, command, callId: outerCallId,
            timestamp: firstDefined(record.timestamp, payload.timestamp, item.timestamp),
            cwd: state.cwd, session: state.session, file,
            callOffset: location.offset, callEnd: location.end, commandIndex,
          });
          if (!observation || group.some((entry) => entry.id === observation.id)) return;
          group.push(observation);
          observations.push(observation);
        });
        if (results.has(groupKey)) applyCodexGroupResult(group, results.get(groupKey));
        continue;
      }

      if (item.type === 'function_call_output' || item.type === 'custom_tool_call_output') {
        const outerCallId = stringValue(firstDefined(item.call_id, item.callId, item.id));
        if (!outerCallId) continue;
        const result = {
          status: classifyCodexOutput(item), offset: location.offset, end: location.end,
          nestedStatuses: item.type === 'custom_tool_call_output'
            ? nestedShellStatuses(item.output) : [],
        };
        const previous = results.get(outerCallId);
        if (previous) {
          result.status = mergeStatus(previous.status, result.status);
          result.nestedStatuses = [
            ...(Array.isArray(previous.nestedStatuses) ? previous.nestedStatuses : []),
            ...result.nestedStatuses,
          ];
        }
        results.set(outerCallId, result);
        applyCodexGroupResult(callGroups.get(outerCallId), result);
      }
    }
  });
  return observations;
}

function arrayValue(value) {
  if (value === undefined || value === null) return [];
  return Array.isArray(value) ? value : [value];
}

function inferSource(rootPath) {
  return /(^|[\\/])\.codex([\\/]|$)/i.test(rootPath) ? 'codex' : 'claude';
}

function normalizeRootEntries(options) {
  const entries = [];
  const add = (source, value) => {
    for (const entry of arrayValue(value)) {
      if (typeof entry === 'string' && entry) entries.push({ source, path: entry });
      else if (isObject(entry)) {
        const entryPath = stringValue(firstDefined(entry.path, entry.root, entry.dir));
        const entrySource = ['claude', 'codex'].includes(entry.source) ? entry.source : source;
        if (entryPath) entries.push({ source: entrySource || inferSource(entryPath), path: entryPath });
      }
    }
  };
  const roots = options.roots;
  if (isObject(roots) && !roots.path && !roots.root && !roots.dir) {
    add('claude', roots.claude);
    add('codex', roots.codex);
  } else {
    for (const entry of arrayValue(roots)) {
      if (typeof entry === 'string') add(inferSource(entry), entry);
      else add(undefined, entry);
    }
  }
  add('claude', options.claudeRoots);
  add('codex', options.codexRoots);
  return entries;
}

function findJsonlFiles(root, source, output, failures) {
  // Transcript roots can contain Windows junctions or symlinked directories.
  // Walking them recursively can revisit the same directory forever and crash
  // the worker with "Maximum call stack size exceeded". Use a real-path set
  // and an iterative walk so either a cycle or extreme nesting is harmless.
  const pending = [root];
  const visitedDirectories = new Set();
  // A path that does not exist is the normal case, not a failure: a machine
  // with no Codex has no `~/.codex/sessions`, and reporting that every scan
  // would leave the error count permanently nonzero. Anything else — EACCES
  // from antivirus, a disconnected profile share, EMFILE — is a subtree we
  // were unable to look at, and used to be swallowed whole: the walk returned
  // no files, so `lastScanStats` read {files:0, observations:0, errors:0},
  // which is exactly what "nothing to do" looks like.
  // Never throws: an exception escaping the walk would take the whole scan and
  // every other root's progress with it, which is the failure mode the per-file
  // try in `scanHistoryFiles` exists to prevent.
  const note = (target, error) => {
    if (error && error.code === 'ENOENT') return;
    if (!Array.isArray(failures)) return;
    const message = (error && error.message) || String(error);
    // `scope: 'root'` distinguishes "could not enumerate this directory" from
    // "read of this file failed". Both are reported through the same channel so
    // the error count is right, but they mean opposite things to the caller
    // deciding whether the scan looked at anything: a file error proves it did,
    // a walk failure proves it could not. Without this field the two were
    // indistinguishable, and the cursor-preservation guard in
    // auto-learn-manager.js was defeated by the very case it was written for.
    failures.push({ path: path.resolve(target), source, mode: 'error', scope: 'root', error: message });
  };
  while (pending.length) {
    const current = pending.pop();
    let stat;
    try { stat = fs.statSync(current); } catch (error) { note(current, error); continue; }
    if (stat.isFile()) {
      if (current.toLowerCase().endsWith('.jsonl')) output.push({ source, path: path.resolve(current) });
      continue;
    }
    if (!stat.isDirectory()) continue;
    let canonical;
    try { canonical = fs.realpathSync.native(current); } catch (error) { note(current, error); continue; }
    canonical = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    if (visitedDirectories.has(canonical)) continue;
    visitedDirectories.add(canonical);
    let entries;
    try { entries = fs.readdirSync(current, { withFileTypes: true }); }
    catch (error) { note(current, error); continue; }
    for (const entry of entries) {
      const child = path.join(current, entry.name);
      // A Windows junction reports isDirectory() AND isFile() false and only
      // isSymbolicLink() true, so queuing on isDirectory() alone skipped the
      // entire subtree with no error at all -- and `isFile()` below rejects a
      // symlink to a transcript for the same reason. Queue every link and let
      // the `statSync` above, which follows links, decide what it is; the
      // realpath set is already there to stop a cycle, which is what it was
      // written for.
      if (entry.isDirectory() || entry.isSymbolicLink()) pending.push(child);
      else if (entry.isFile() && entry.name.toLowerCase().endsWith('.jsonl')) {
        output.push({ source, path: path.resolve(child) });
      }
    }
  }
}

function hashBuffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

// `chunk` is a parameter rather than a bare constant so a test can drive the
// chunking with a small file. A 2 GiB fixture is not writable in a test suite,
// and a cap that only its own default can reach is a guard nothing can prove.
function readRange(file, start, length, chunk = READ_CHUNK_BYTES) {
  if (length <= 0) return Buffer.alloc(0);
  const descriptor = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(length);
    let total = 0;
    while (total < length) {
      // Never hand readSync more than one chunk in a call. Passing the whole
      // remainder is what made a file over 2 GiB unreadable: the int32 length
      // wrapped negative and threw before a single byte was read.
      const want = Math.min(length - total, Math.max(1, chunk));
      const count = fs.readSync(descriptor, buffer, total, want, start + total);
      if (count === 0) break;
      total += count;
    }
    return total === length ? buffer : buffer.subarray(0, total);
  } finally {
    fs.closeSync(descriptor);
  }
}

function fingerprintFile(file, size) {
  const headLength = Math.min(FINGERPRINT_BYTES, size);
  const tailStart = Math.max(0, size - FINGERPRINT_BYTES);
  const tailLength = size - tailStart;
  return {
    headLength,
    headHash: hashBuffer(readRange(file, 0, headLength)),
    tailStart,
    tailLength,
    tailHash: hashBuffer(readRange(file, tailStart, tailLength)),
  };
}

// On the unchanged fast path the new fingerprint is provably the prior one:
// `safeContinuation` has just re-hashed exactly these two ranges and compared
// them, and the size has not moved, so `fingerprintFile` would read the same
// 8 KB and produce the same two digests. Reusing them saves two reads and two
// hashes per unchanged file (~131 us each, and the corpus is almost entirely
// unchanged files). Guarded on the ranges being the ones this version would
// choose, so a cursor written by an older or hand-edited build is rebuilt at
// full strength rather than having its weaker ranges carried forward forever.
function continuedFingerprint(prior, size) {
  if (!isObject(prior)) return null;
  const tailStart = Math.max(0, size - FINGERPRINT_BYTES);
  if (prior.headLength !== Math.min(FINGERPRINT_BYTES, size)) return null;
  if (prior.tailStart !== tailStart || prior.tailLength !== size - tailStart) return null;
  if (!prior.headHash || !prior.tailHash) return null;
  return {
    headLength: prior.headLength, headHash: prior.headHash,
    tailStart, tailLength: prior.tailLength, tailHash: prior.tailHash,
  };
}

// Codex records the session id and `cwd` ONLY in the head-of-file
// `session_meta` line. An append slice starts at `prior.size - overlapBytes`,
// so the head is absent, both stay undefined, and the manager then drops the
// observation outright when a workspace root is configured
// (`src/auto-learn-manager.js:1774`, `within(root, undefined) === false`) --
// or keeps it under a SECOND identity, because `session` is part of
// `identityParts` (:75-77). Two ids for one call defeat the `observationHashes`
// dedupe and inflate `counts.success`, which is what gates auto-safe apply.
//
// So the head line is re-read, and deliberately NOT cached on the cursor: a
// cwd is a user path and no path may reach persisted state. One extra read per
// changed Codex transcript is the cheap half of that trade.
//
// It has to read FORWARD to the first newline rather than grab a fixed prefix.
// On a real 0.153.4 rollout the `session_meta` line is 22,095 bytes, because
// `payload.base_instructions.text` carries the whole ~21 KB system prompt, and
// a read that stops mid-record yields no parseable line at all --
// `parseJsonlRecords` skips unparseable lines in silence, so the failure would
// look exactly like a transcript with no session_meta. FINGERPRINT_BYTES is
// 4096, so the head read `safeContinuation` already did cannot be reused
// either. Capped, and a cap miss simply yields no seed.
const SEED_CHUNK_BYTES = 64 * 1024;
const SEED_MAX_BYTES = 1024 * 1024;

function codexHeadSeed(file) {
  try {
    const chunks = [];
    let total = 0;
    let newline = -1;
    while (newline === -1 && total < SEED_MAX_BYTES) {
      const chunk = readRange(file, total, Math.min(SEED_CHUNK_BYTES, SEED_MAX_BYTES - total));
      if (!chunk.length) break;
      newline = chunk.indexOf(10);
      chunks.push(newline === -1 ? chunk : chunk.subarray(0, newline));
      total += chunk.length;
    }
    if (newline === -1) return null;
    const line = Buffer.concat(chunks).toString('utf8').replace(/\r$/, '');
    const record = JSON.parse(line);
    if (!isObject(record)) return null;
    const seed = applyCodexSessionState(record, {});
    return seed.session === undefined && seed.cwd === undefined ? null : seed;
  } catch { return null; }
}

function cursorKeyForFile(file) {
  const absolutePath = path.normalize(path.resolve(file));
  const canonicalPath = process.platform === 'win32' ? absolutePath.toLowerCase() : absolutePath;
  const digest = crypto.createHash('sha256').update(canonicalPath, 'utf8').digest('hex').slice(0, 24);
  return `path-sha256:${digest}`;
}

function priorCursorFor(cursors, absolutePath, originalPath) {
  const hashedKey = cursorKeyForFile(absolutePath);
  if (cursors instanceof Map) {
    return cursors.get(hashedKey) || cursors.get(absolutePath) || cursors.get(originalPath);
  }
  if (!isObject(cursors)) return undefined;
  return cursors[hashedKey] || cursors[absolutePath] || cursors[originalPath];
}

function safeContinuation(file, stat, prior, source) {
  if (!isObject(prior) || !Number.isFinite(prior.size) || stat.size < prior.size) return false;
  if (prior.source && prior.source !== source) return false;
  if (prior.ino && stat.ino && String(prior.ino) !== String(stat.ino)) return false;
  if (![prior.headLength, prior.tailStart, prior.tailLength].every(Number.isFinite)) return false;
  if (!prior.headHash || !prior.tailHash) return false;
  if (prior.headLength > stat.size || prior.tailStart + prior.tailLength > stat.size) return false;
  try {
    return hashBuffer(readRange(file, 0, prior.headLength)) === prior.headHash &&
      hashBuffer(readRange(file, prior.tailStart, prior.tailLength)) === prior.tailHash;
  } catch {
    return false;
  }
}

// `consumedSize` is what this scan actually accounted for, which is the file
// size in every case except a capped read. A cursor has always meant "bytes
// [0, size) are accounted for" and that is exactly what is being preserved:
// recording stat.size after consuming less would convert a bounded catch-up
// into a silent skip, which is the one thing the ingest cap must not do.
function cursorForFile(file, source, stat, fingerprint, consumedSize) {
  const size = Number.isFinite(consumedSize) ? consumedSize : stat.size;
  return {
    source, size, offset: size, mtimeMs: stat.mtimeMs,
    ino: stat.ino || undefined, ...(fingerprint || fingerprintFile(file, size)),
  };
}

// The Buffer is handed on undecoded on purpose: `parseJsonlRecords` needs the
// bytes to hand out byte offsets for free, and decoding here threw them away.
function parseHistorySlice(source, buffer, options) {
  return source === 'codex' ? parseCodexJsonl(buffer, options) : parseClaudeJsonl(buffer, options);
}

function appendedResultIds(source, buffer) {
  const ids = new Set();
  parseJsonlRecords(buffer, {}, (record) => {
    if (source === 'codex') {
      for (const item of codexItems(record)) {
        if (item.type !== 'function_call_output' && item.type !== 'custom_tool_call_output') continue;
        const id = stringValue(firstDefined(item.call_id, item.callId, item.id));
        if (id) ids.add(id);
      }
      return;
    }
    for (const message of claudeMessageCandidates(record)) {
      if (!Array.isArray(message.content)) continue;
      walkObjectBlocks(message.content, (block) => {
        if (block.type !== 'tool_result') return;
        const id = stringValue(firstDefined(block.tool_use_id, block.toolUseId, block.call_id, block.callId));
        if (id) ids.add(id);
      });
    }
    if (record.type === 'tool_result') {
      const id = stringValue(firstDefined(record.tool_use_id, record.toolUseId, record.call_id, record.callId));
      if (id) ids.add(id);
    }
  });
  return ids;
}

// Safe appends read a bounded overlap plus new bytes. Stable observation ids let
// callers upsert a call when its result arrives on the other side of a cursor.
function scanHistoryFiles(options = {}) {
  const priorCursors = options.cursors || options.priorCursors || {};
  const overlapBytes = Number.isFinite(options.overlapBytes)
    ? Math.max(0, Math.floor(options.overlapBytes))
    : DEFAULT_OVERLAP_BYTES;
  // 0 disables the cap, matching what every other limit in this codebase does
  // with 0. Tests set it small to exercise catch-up without a gigabyte fixture.
  const ingestBytes = Number.isFinite(options.ingestBytes)
    ? Math.max(0, Math.floor(options.ingestBytes))
    : DEFAULT_INGEST_BYTES;
  const readChunkBytes = Number.isFinite(options.readChunkBytes)
    ? Math.max(1, Math.floor(options.readChunkBytes))
    : READ_CHUNK_BYTES;
  const reconcileBytes = Number.isFinite(options.reconcileBytes)
    ? Math.max(0, Math.floor(options.reconcileBytes))
    : RECONCILE_MAX_BYTES;
  const found = [];
  // Reported through the same per-file error channel as a failed read, so a
  // root we could not enumerate raises the error count instead of looking like
  // an empty corpus. The manager reads this to decide whether the scan has
  // earned the right to replace the cursor map at all.
  const walkFailures = [];
  for (const root of normalizeRootEntries(options)) {
    findJsonlFiles(root.path, root.source, found, walkFailures);
  }
  const unique = new Map();
  for (const entry of found) {
    const key = process.platform === 'win32' ? entry.path.toLowerCase() : entry.path;
    if (!unique.has(key)) unique.set(key, entry);
  }
  const observations = [];
  const cursors = {};
  const files = [...walkFailures];
  const sorted = [...unique.values()].sort((a, b) => a.path.localeCompare(b.path));

  for (const entry of sorted) {
    const file = entry.path;
    let stat;
    try { stat = fs.statSync(file); } catch (error) {
      files.push({ path: file, source: entry.source, mode: 'error', error: error.message });
      continue;
    }
    const prior = priorCursorFor(priorCursors, file, entry.path);
    const cursorKey = cursorKeyForFile(file);
    // Everything from here is inside the per-file try. It used not to be: the
    // three `readRange` calls below, and `cursorForFile` on the `unchanged`
    // fast path, all sat outside it. `readRange` throws on ENOENT for a
    // transcript deleted between the enumeration above and the read, on
    // EACCES/EPERM/EBUSY while antivirus or another process holds a Windows
    // lock, on EMFILE, and on ERR_OUT_OF_RANGE for a file past the buffer
    // limit. Any of those escaped `scanHistoryFiles`, escaped `scan()`, and
    // took `save(state)` with it, so ONE transient failure among hundreds of
    // files discarded every other file's cursor progress and the extension
    // then backed its retry off to an hour. The fast path was the easiest to
    // miss, because it looks read-only and is in fact two file reads deep.
    let safe = false;
    let mode = 'full';
    // Tracked out here so the catch can report it. A read that threw had still
    // read something, and reporting `bytesRead: 0` for a file that had just
    // pulled 118 MB off disk is how the oversized-transcript defect stayed
    // invisible in `lastScanStats` for eight days.
    let readBytes = 0;
    const readSlice = (from, to) => {
      const slice = readRange(file, from, to - from, readChunkBytes);
      readBytes += slice.length;
      return slice;
    };
    try {
      safe = safeContinuation(file, stat, prior, entry.source);
      if (safe && stat.size === prior.size) {
        cursors[cursorKey] = cursorForFile(file, entry.source, stat,
          continuedFingerprint(prior, stat.size));
        files.push({ path: file, source: entry.source, mode: 'unchanged', size: stat.size, bytesRead: 0 });
        continue;
      }

      mode = safe && stat.size > prior.size ? 'append' : 'full';
      let start = 0;
      let buffer;
      // `partial` is deliberately NOT a third value of `mode`: the observation
      // filter below and the Codex seed both branch on 'append' vs 'full', and
      // a capped first-sight read is still a full read that happens to stop
      // early. Only the REPORTED mode says 'partial'.
      let partial = false;
      let unmatched = 0;
      // Where this scan stops. The cap is what keeps one huge transcript from
      // owning a tick: the cursor records exactly what was consumed and the
      // next scan resumes there, so the file catches up over several ticks
      // instead of being re-read whole, forever, and never finishing.
      // Budgeted from the CURSOR, not from the slice start. Measuring it from
      // the slice start looked equivalent and was not: the overlap reaches back
      // up to 256 KB, so on a cap smaller than the overlap the whole budget was
      // spent re-reading bytes already accounted for, the cursor never moved,
      // and catch-up looped forever. The read therefore spans at most
      // overlap + ingestBytes, and always clears at least ingestBytes of new
      // ground.
      const capBase = safe && prior && Number.isFinite(prior.size) ? prior.size : 0;
      const capFrom = () => (ingestBytes > 0 ? Math.min(stat.size, capBase + ingestBytes) : stat.size);
      let consumedEnd = stat.size;
      if (mode === 'append') {
        const tentativeStart = Math.max(0, prior.size - overlapBytes);
        consumedEnd = capFrom();
        buffer = readSlice(tentativeStart, consumedEnd);
        start = tentativeStart;
        if (tentativeStart > 0) {
          const oldPrefixLength = Math.min(prior.size - tentativeStart, buffer.length);
          const newline = buffer.subarray(0, oldPrefixLength).indexOf(10);
          if (newline === -1) {
            mode = 'full';
            start = 0;
            consumedEnd = capFrom();
            buffer = readSlice(0, consumedEnd);
          } else {
            start = tentativeStart + newline + 1;
            buffer = buffer.subarray(newline + 1);
          }
        }
      } else {
        consumedEnd = capFrom();
        buffer = readSlice(0, consumedEnd);
      }
      if (consumedEnd < stat.size) {
        // A slice cut at the cap almost certainly ends mid-record. Widen until
        // a boundary appears, because a half-record can neither be parsed nor
        // resumed from, and stop at the hard maximum rather than sliding back
        // into the unbounded read this whole change exists to remove.
        while (buffer.lastIndexOf(10) === -1
          && consumedEnd < stat.size
          && consumedEnd - start < INGEST_HARD_MAX_BYTES) {
          consumedEnd = Math.min(stat.size, start + Math.max((consumedEnd - start) * 4, 4096));
          buffer = readSlice(start, consumedEnd);
        }
        if (consumedEnd < stat.size) {
          const boundary = buffer.lastIndexOf(10);
          if (boundary === -1) {
            throw new Error(
              `no record boundary within ${buffer.length} bytes of offset ${start}`);
          }
          buffer = buffer.subarray(0, boundary + 1);
          consumedEnd = start + buffer.length;
          partial = true;
        }
      }

        // Seeded only where the head is genuinely out of the slice, and only
        // for Codex, which is the only source that states the session and cwd
        // once at the top of the file. Claude repeats both on every record, so
        // Claude transcripts -- the volume -- pay nothing for this.
        // `start > 0` is the real condition, not the mode: a capped read that
        // begins past the top of the file has the same missing head whether it
        // is reported as append or partial.
        const seed = entry.source === 'codex' && start > 0
          ? codexHeadSeed(file) : null;
        let parsed = parseHistorySlice(entry.source, buffer, {
          file, baseOffset: start, platform: options.platform, defaultTool: options.defaultTool,
          probeMatcher: options.probeMatcher,
          session: seed && seed.session, cwd: seed && seed.cwd,
        });
        if (mode === 'append') {
          const appendedStart = Math.max(0, prior.size - start);
          const resultIds = appendedResultIds(entry.source, buffer.subarray(appendedStart));
          let parsedCalls = new Set(parsed.map((observation) => observation.callId).filter(Boolean));
          let missing = [...resultIds].filter((id) => !parsedCalls.has(id));
          if (missing.length) {
            // The bounded overlap did not reach the matching request. Widen
            // BACKWARDS by a bounded amount rather than re-reading the whole
            // file. The unbounded re-read that used to live here is what cost
            // 570 ms of every tick on a 2,266,973,030-byte transcript and never
            // completed, because the read it asked for could not be performed.
            const wideStart = Math.max(0, start - reconcileBytes);
            if (wideStart < start) {
              const wide = readSlice(wideStart, consumedEnd);
              // Align forward to a record boundary unless we reached the top of
              // the file, where offset 0 already is one.
              const newline = wideStart === 0 ? -1 : wide.indexOf(10);
              if (wideStart === 0 || newline !== -1) {
                start = wideStart === 0 ? 0 : wideStart + newline + 1;
                buffer = wideStart === 0 ? wide : wide.subarray(newline + 1);
                parsed = parseHistorySlice(entry.source, buffer, {
                  file, baseOffset: start, platform: options.platform,
                  defaultTool: options.defaultTool, probeMatcher: options.probeMatcher,
                });
                parsedCalls = new Set(parsed.map((observation) => observation.callId).filter(Boolean));
                missing = [...resultIds].filter((id) => !parsedCalls.has(id));
              }
            }
            // Whatever is still unmatched is REPORTED rather than dropped in
            // silence. It is not converted into evidence either way: an
            // observation needs its call, so the family is neither credited
            // with a success nor cleared of a failure it never saw.
            unmatched = missing.length;
          }
        }
        const selected = mode === 'full'
          ? parsed
          : parsed.filter((observation) =>
            observation._callEnd > prior.size || observation._resultEnd > prior.size
          );
        observations.push(...selected);
        // The cursor records what was CONSUMED, not how big the file is. On a
        // capped read those differ, and claiming the larger number is what
        // would turn a bounded catch-up into a silent skip.
        cursors[cursorKey] = cursorForFile(file, entry.source, stat, null, consumedEnd);
        files.push({
          path: file, source: entry.source, mode: partial ? 'partial' : mode, size: stat.size,
          bytesRead: readBytes, observations: selected.length,
          ...(partial ? { consumedEnd } : {}),
          ...(unmatched ? { unmatchedResults: unmatched } : {}),
        });
    } catch (error) {
      // Carry the prior cursor forward ONLY when it still describes the file.
      // When `safe` is false the file was rewritten or truncated, so the prior
      // offset points into bytes that no longer exist, and writing it back made
      // the next scan resume from the wrong place and silently skip real
      // observations. Better to re-read a file we failed on than to claim
      // progress we did not make.
      //
      // A first-sight failure therefore still records no cursor and is re-read
      // next scan. That is deliberate: the alternative, inventing a cursor we
      // did not earn, trades a bounded I/O cost for permanent data loss. Making
      // it skip-until-changed needs a failure-tracking structure of its own, and
      // that is a design decision, not an omission. The reasoning above is the
      // whole of it; there is no backlog entry to go and read.
      if (safe && prior) cursors[cursorKey] = prior;
      files.push({
        path: file, source: entry.source, mode: 'error', size: stat.size,
        bytesRead: readBytes, error: error.message,
      });
    }
  }
  return { observations, cursors, files };
}

module.exports = {
  parseClaudeJsonl,
  parseCodexJsonl,
  extractNestedShellCommands,
  cursorKeyForFile,
  scanHistoryFiles,
  // Exported for the guard that pins it below the int32 ceiling readSync
  // enforces. Nothing in production reads it from here.
  READ_CHUNK_BYTES,
};
