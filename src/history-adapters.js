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
    // A queued entry is either a bare path, which still needs identifying, or
    // { path, dir: true } for one `readdirSync` already told us is a real
    // directory. MEASURED 2026-09-22, cold, fresh interleaved processes
    // against a byte-identical control arm: skipping the stat and the
    // realpath for those is +20.76 min / +22.10 p50 of a 241 ms tick.
    const queued = pending.pop();
    const current = typeof queued === 'string' ? queued : queued.path;
    const knownDirectory = typeof queued !== 'string' && queued.dir === true;
    let stat;
    if (!knownDirectory) {
      try { stat = fs.statSync(current); } catch (error) { note(current, error); continue; }
    }
    if (stat && stat.isFile()) {
      if (current.toLowerCase().endsWith('.jsonl')) output.push({ source, path: path.resolve(current) });
      continue;
    }
    if (stat && !stat.isDirectory()) continue;
    let canonical;
    if (knownDirectory) {
      // The key comes from the PARENT's canonical key plus this entry's name,
      // so every key descends from a realpath'd ancestor and is spelled the
      // way realpath spells it.
      //
      // `path.resolve` was tried here first and is NOT enough. It preserves an
      // 8.3 short component -- GitHub's Windows runners hand out a %TEMP% of
      // `C:\Users\RUNNER~1\...` -- while `realpathSync.native` expands it, so
      // the same directory reached directly and through a junction got two
      // different keys, was walked twice, and its transcripts were observed
      // twice. A double count inflates the success total that gates auto-safe.
      // It passed the whole suite locally and failed only on CI, which is the
      // second time this exact short-path trap has bitten this repo.
      canonical = queued.canonical;
    } else {
      try { canonical = fs.realpathSync.native(current); } catch (error) { note(current, error); continue; }
      canonical = process.platform === 'win32' ? canonical.toLowerCase() : canonical;
    }
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
      // Only a genuine directory skips the stat below. A link of any kind,
      // including a Windows junction, is queued bare so `statSync` and
      // `realpathSync` still decide what it is and the cycle set still sees
      // its true identity.
      if (entry.isDirectory()) {
        const name = process.platform === 'win32' ? entry.name.toLowerCase() : entry.name;
        pending.push({ path: child, dir: true, canonical: canonical + path.sep + name });
      }
      else if (entry.isSymbolicLink()) pending.push(child);
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
    // A throwing `closeSync` in a `finally` REPLACES the in-flight error, and
    // the in-flight error is the only diagnostic a caller ever gets for an
    // unreadable stretch: `scanHistoryFiles`' per-file catch records
    // `error.message` into `files[].error` and nothing else survives. A close
    // failure (EBADF after an interrupted read, EIO on a disconnected share)
    // would land there instead of the EACCES or ERR_OUT_OF_RANGE that says what
    // actually went wrong, and the descriptor is already unusable either way.
    // `src/policy-lock.js:143` and `atomicWrite` in auto-learn-manager.js wrap
    // theirs for the same reason; this was the one that did not.
    try { fs.closeSync(descriptor); } catch {}
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

function priorCursorFor(cursors, absolutePath, originalPath, precomputedKey) {
  // The caller has usually just computed this exact hash for the same path.
  // It is a pure function, so reusing it is identity, and it is +5.09 min.
  const hashedKey = precomputedKey || cursorKeyForFile(absolutePath);
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
  // Size, mtime and inode all match what the cursor recorded, so the file has
  // not been written since we looked. Re-hashing two 4 KB ranges can only
  // confirm that, and doing it for every unchanged transcript on every tick is
  // half the cost of a quiet scan: MEASURED 2026-09-22, cold, one call per
  // fresh process, interleaved against a variant with this clause removed:
  //
  //   with the re-hash     330.2 / 294.4 / 298.4 ms
  //   without              144.1 / 142.2 / 152.8 ms
  //
  // WHAT THIS STOPS DETECTING, stated plainly: a file rewritten in place at
  // exactly the same size, keeping the same inode, with its mtime restored to
  // what it was. Nothing that writes these transcripts does that -- agents
  // append -- and a replaced file gets a new file id, which the inode check at
  // the top of this function already rejects. A rewrite that changes the
  // mtime, which is every ordinary one, still forces a full re-read. If a
  // future source of transcripts rewrites in place with preserved timestamps,
  // delete this clause.
  //
  // No inode leg here on purpose: the guard above has already returned false
  // for a mismatch, so a second test could never change an outcome. It was
  // written, its mutation SURVIVED, and that is how it was found.
  if (prior.size === stat.size && prior.mtimeMs === stat.mtimeMs) return true;
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

// Every call id in a slice, whether or not it became an observation. The
// mirror of appendedResultIds, and the difference matters: createObservation
// returns null for a tool the learner does not track, so matching results
// against OBSERVATIONS counted a TodoWrite or Read result as a call we had
// never seen. That over-reported unmatchedResults and, worse, sent the
// reconcile widening backwards after a call that could never produce an
// observation -- up to the full reconcile bound, on every scan, forever.
// MEASURED live 2026-09-22: 96 such results in one tick, all noise.
function sliceCallIds(source, buffer) {
  const ids = new Set();
  parseJsonlRecords(buffer, {}, (record) => {
    if (source === 'codex') {
      for (const item of codexItems(record)) {
        if (item.type !== 'function_call' && item.type !== 'custom_tool_call') continue;
        const id = stringValue(firstDefined(item.call_id, item.callId, item.id));
        if (id) ids.add(id);
      }
      return;
    }
    for (const message of claudeMessageCandidates(record)) {
      if (!Array.isArray(message.content)) continue;
      walkObjectBlocks(message.content, (block) => {
        if (block.type !== 'tool_use') return;
        const id = stringValue(firstDefined(block.id, block.tool_use_id, block.callId));
        if (id) ids.add(id);
      });
    }
  });
  return ids;
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
  // Injectable for the same reason the chunk cap is: the branch it guards is
  // only reachable past a quarter-gigabyte without a newline, and a guard no
  // test can reach is a guard nobody has checked.
  const ingestHardMax = Number.isFinite(options.ingestHardMaxBytes)
    ? Math.max(1, Math.floor(options.ingestHardMaxBytes))
    : INGEST_HARD_MAX_BYTES;
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
    const cursorKey = cursorKeyForFile(file);
    const prior = priorCursorFor(priorCursors, file, entry.path, cursorKey);
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
      // Set only where a stretch of the file holds no record boundary at all
      // and had to be stepped over. Reported, never silent.
      let unreadableFrom = -1;
      let unreadableBytes = 0;
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
      // The cut has to land in ground this scan has NOT already accounted for,
      // or it makes no progress. Taking the last newline anywhere in the buffer
      // looked equivalent and was not: the overlap reaches back before the
      // cursor and is full of old newlines, so a capped window holding one
      // oversized record cut back to `prior.size` every tick, forever, and
      // could even cut BEFORE it when the previous scan had ended mid-record.
      // That is the original defect in a rarer shape, one layer down from the
      // budget base that was fixed with it.
      const newGroundFloor = Math.max(0, capBase - start);
      const lastBoundary = (buf) => {
        const at = buf.lastIndexOf(10);
        return at >= newGroundFloor ? at : -1;
      };
      if (consumedEnd < stat.size) {
        // A slice cut at the cap almost certainly ends mid-record. Widen until
        // a boundary appears, because a half-record can neither be parsed nor
        // resumed from, and stop at the hard maximum rather than sliding back
        // into the unbounded read this whole change exists to remove.
        while (lastBoundary(buffer) === -1
          && consumedEnd < stat.size
          && consumedEnd - start < ingestHardMax) {
          // Clamped to the hard maximum, not merely stopped by it. Widening by
          // four from a 64 MiB slice asks for 256 MiB in one allocation, and
          // the guard above only decides whether to widen AGAIN, so without
          // this the peak is the old slice plus a quarter-gigabyte.
          consumedEnd = Math.min(
            stat.size,
            start + ingestHardMax,
            start + Math.max((consumedEnd - start) * 4, 4096));
          buffer = readSlice(start, consumedEnd);
        }
        if (consumedEnd < stat.size) {
          const boundary = lastBoundary(buffer);
          if (boundary === -1) {
            // No record boundary anywhere in the hard maximum. This is not a
            // transient failure, so throwing would re-read the same bytes on
            // every tick forever -- which is the exact pathology the ingest cap
            // exists to remove, reached through the widening path instead of
            // the int32 one. Advance past what was examined and SAY SO: the
            // file is reported unreadable with the byte count skipped, rather
            // than dropped in silence or retried without end.
            unreadableFrom = start;
            unreadableBytes = buffer.length;
            consumedEnd = start + buffer.length;
            buffer = buffer.subarray(0, 0);
          } else {
            buffer = buffer.subarray(0, boundary + 1);
            consumedEnd = start + buffer.length;
          }
          partial = true;
        }
      }

        // Seeded only where the head is genuinely out of the slice, and only
        // for Codex, which is the only source that states the session and cwd
        // once at the top of the file. Claude repeats both on every record, so
        // Claude transcripts -- the volume -- pay nothing for this.
        // `start > 0` is the whole condition, and it already implies append:
        // `start` is only ever assigned non-zero inside the append branch, and
        // the append-to-full fallback resets it. The previous spelling paired
        // it with a mode test that no input could distinguish, under a comment
        // claiming it covered capped reads -- which begin at 0 and so were
        // never the case. Dropped rather than kept as decoration.
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
          // Seen means seen, not observed. A call present in the slice but
          // deliberately not tracked still answers "have we read this call".
          let parsedCalls = new Set(parsed.map((observation) => observation.callId).filter(Boolean));
          let seenCalls = sliceCallIds(entry.source, buffer);
          let missing = [...resultIds]
            .filter((id) => !parsedCalls.has(id) && !seenCalls.has(id));
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
                // The seed goes to the WIDENED parse too. The unbounded version
                // of this re-read started at byte 0, where the session_meta
                // line lives, so it never needed one. A bounded widen still
                // begins mid-file, and without the seed every observation this
                // reconcile exists to rescue comes back with session and cwd
                // undefined -- which a configured workspace root then drops
                // outright, and which otherwise files the call under a SECOND
                // identity, because session is part of identityParts.
                parsed = parseHistorySlice(entry.source, buffer, {
                  file, baseOffset: start, platform: options.platform,
                  defaultTool: options.defaultTool, probeMatcher: options.probeMatcher,
                  ...(start > 0 ? { session: seed && seed.session, cwd: seed && seed.cwd } : {}),
                });
                parsedCalls = new Set(parsed.map((observation) => observation.callId).filter(Boolean));
                seenCalls = sliceCallIds(entry.source, buffer);
                missing = [...resultIds]
                  .filter((id) => !parsedCalls.has(id) && !seenCalls.has(id));
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
          path: file, source: entry.source,
          mode: unreadableBytes ? 'unreadable' : (partial ? 'partial' : mode),
          size: stat.size,
          bytesRead: readBytes, observations: selected.length,
          ...(partial ? { consumedEnd } : {}),
          ...(unmatched ? { unmatchedResults: unmatched } : {}),
          ...(unreadableBytes ? { unreadableFrom, unreadableBytes } : {}),
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

// ── Codex history-store staleness ─────────────────────────────────────────────
//
// THE READER IS CORRECT TODAY. THIS IS THE DETECTOR FOR THE DAY IT IS NOT.
//
// MEASURED ON THE DEVELOPMENT BOX 2026-09-24 against codex-cli 0.145.0: Codex
// writes the rollout JSONL files under `~/.codex/sessions` that `scanHistoryFiles`
// consumes AND maintains `~/.codex/thread_history_1.sqlite` beside them, whose
// tables are `thread_turns` (20 rows), `thread_items` (567) and
// `thread_history_projection_state` (52). That last table is literally a cursor
// INTO the rollout files — its columns are `thread_id`, `next_rollout_byte_offset`
// and `next_rollout_ordinal` — and its 52 rows matched the 52 rollout files
// exactly, with zero orphans in either direction. So sqlite is a PROJECTION of
// the rollout files, not a replacement for them, and rewriting the reader to
// read sqlite would trade a correct source for a derived one.
//
// What has no detector is the day that stops being true. A migration that moves
// the source of truth into the store leaves `~/.codex/sessions` frozen, and a
// scan of a frozen directory returns `{files: 52, observations: 0, errors: 0}` —
// indistinguishable from a quiet week. Same shape as the `blindScan` guard in
// auto-learn-manager.js, and it is here for the same reason: the numbers a
// healthy scan reports and the numbers a blind one reports are identical.
//
// TWO TIERS, AND THE RESULT SAYS WHICH ONE RAN.
//
//   exact   — `node:sqlite` opened the store read-only and listed the thread ids
//             it knows about. A thread id in the store with no rollout file on
//             disk is proof the store outran the directory.
//   partial — the store could not be opened (no `node:sqlite` before Node 22,
//             a locked or corrupt database, a permission error). Falls back to
//             `session_index.jsonl`, which names thread ids in plain JSONL, and
//             to the presence of applied entries in `rollout-migrations/`.
//
// A partial inspection that finds nothing says `inspected: 'partial'` and names
// why. It never reports `healthy`, because it cannot: the evidence it needs was
// unavailable, and a control that can run degraded has to say so on every run.

const CODEX_THREAD_STORE = /^thread_history[^/\\]*\.sqlite$/i;
const THREAD_ID = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})/i;

function rolloutThreadIds(sessionsDir) {
  const ids = new Set();
  let files = 0;
  const pending = [sessionsDir];
  const seen = new Set();
  while (pending.length) {
    const dir = pending.pop();
    let real;
    try { real = fs.realpathSync(dir); } catch { continue; }
    if (seen.has(real)) continue;
    seen.add(real);
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { pending.push(full); continue; }
      if (!entry.name.toLowerCase().endsWith('.jsonl')) continue;
      files += 1;
      const match = THREAD_ID.exec(entry.name);
      if (match) ids.add(match[1].toLowerCase());
    }
  }
  return { ids, files };
}

// Read-only, best effort, and never allowed to throw into a scan. `node:sqlite`
// is unavailable on Node 20 and flagged on Node 22, so the require itself is the
// first thing that can fail.
function readThreadStoreIds(storePath) {
  let sqlite;
  try { sqlite = require('node:sqlite'); }
  catch { return { ok: false, reason: 'node:sqlite is unavailable on this Node runtime' }; }
  if (!sqlite || typeof sqlite.DatabaseSync !== 'function') {
    return { ok: false, reason: 'node:sqlite exposes no DatabaseSync' };
  }
  let db = null;
  try {
    db = new sqlite.DatabaseSync(storePath, { readOnly: true });
    const ids = new Set();
    const tables = new Set(db.prepare(
      "select name from sqlite_master where type='table'",
    ).all().map((row) => String(row.name)));
    let read = 0;
    for (const [table, column] of [
      ['thread_history_projection_state', 'thread_id'],
      ['thread_items', 'thread_id'],
      ['thread_turns', 'thread_id'],
    ]) {
      if (!tables.has(table)) continue;
      for (const row of db.prepare(`select distinct ${column} as id from "${table}"`).all()) {
        if (row.id) ids.add(String(row.id).toLowerCase());
      }
      read += 1;
    }
    if (!read) return { ok: false, reason: `${path.basename(storePath)} holds no known thread-history table` };
    return { ok: true, ids };
  } catch (error) {
    return { ok: false, reason: `${path.basename(storePath)}: ${String(error?.message || error)}` };
  } finally {
    try { db?.close(); } catch { /* a close failure cannot change the verdict */ }
  }
}

function sessionIndexIds(indexPath) {
  let text;
  try { text = fs.readFileSync(indexPath, 'utf8'); }
  catch (error) { return error?.code === 'ENOENT' ? { ok: true, ids: new Set() } : { ok: false, reason: String(error?.message || error) }; }
  const ids = new Set();
  let malformed = 0;
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      const id = stringValue(firstDefined(record?.id, record?.thread_id, record?.threadId));
      if (id) ids.add(id.toLowerCase());
      else malformed += 1;
    } catch { malformed += 1; }
  }
  return { ok: true, ids, malformed };
}

function codexHistoryStoreState(options = {}) {
  const home = options.home ? String(options.home) : null;
  const codexHome = options.codexHome ? String(options.codexHome)
    : home ? path.join(home, '.codex') : null;
  const sessionsDir = options.sessionsDir ? String(options.sessionsDir)
    : codexHome ? path.join(codexHome, 'sessions') : null;
  const reasons = [];
  const notes = [];
  if (!codexHome || !sessionsDir) {
    return {
      present: false, stale: false, inspected: 'skipped', reasons: [],
      notes: ['No Codex home was supplied, so no history-store check ran.'],
      rolloutFiles: 0, storeFiles: [], migrations: 0, orphans: [],
    };
  }

  let entries = [];
  try { entries = fs.readdirSync(codexHome, { withFileTypes: true }); }
  catch (error) {
    if (error?.code === 'ENOENT') {
      return {
        present: false, stale: false, inspected: 'exact', reasons: [],
        notes: ['No ~/.codex directory, so Codex history is not in use on this machine.'],
        rolloutFiles: 0, storeFiles: [], migrations: 0, orphans: [],
      };
    }
    return {
      present: false, stale: false, inspected: 'partial',
      reasons: [],
      notes: [`The Codex home could not be listed (${error?.code || 'error'}), so staleness is unknown.`],
      rolloutFiles: 0, storeFiles: [], migrations: 0, orphans: [],
    };
  }

  const storeFiles = entries
    .filter((entry) => entry.isFile() && CODEX_THREAD_STORE.test(entry.name))
    .map((entry) => path.join(codexHome, entry.name))
    .sort();
  let migrations = 0;
  try {
    migrations = fs.readdirSync(path.join(codexHome, 'rollout-migrations')).length;
  } catch { migrations = 0; }

  const rollouts = rolloutThreadIds(sessionsDir);
  const known = new Set();
  // Starts exact and is DOWNGRADED by anything that could not be read. With no
  // store file present there is nothing to diverge from, and that is a real
  // exact answer rather than an absent one.
  let inspected = 'exact';
  for (const store of storeFiles) {
    const result = readThreadStoreIds(store);
    if (!result.ok) {
      inspected = 'partial';
      notes.push(`The thread-history store could not be read (${result.reason}), so the exact ` +
        'rollout-versus-store comparison did not run.');
      continue;
    }
    for (const id of result.ids) known.add(id);
  }

  const index = sessionIndexIds(path.join(codexHome, 'session_index.jsonl'));
  if (!index.ok) {
    inspected = 'partial';
    notes.push(`session_index.jsonl could not be read (${index.reason}).`);
  } else {
    for (const id of index.ids) known.add(id);
  }

  const orphans = [...known].filter((id) => !rollouts.ids.has(id)).sort();
  if (orphans.length) {
    reasons.push(`${orphans.length} Codex thread(s) exist in the history store or session index ` +
      `with no rollout file under ${sessionsDir}. The reader consumes rollout files only, so ` +
      'those threads are invisible to it.');
  }
  if (migrations > 0) {
    reasons.push(`${migrations} entr${migrations === 1 ? 'y' : 'ies'} in ${path.join(codexHome, 'rollout-migrations')}: ` +
      'Codex has run a rollout migration, which is the mechanism that would move the source of truth.');
  }
  if (storeFiles.length && rollouts.files === 0 && known.size > 0) {
    reasons.push(`The rollout directory holds no transcripts while the history store knows of ` +
      `${known.size} thread(s). The reader would report a clean scan of an empty directory.`);
  }

  if (inspected === 'partial' && !reasons.length) {
    notes.push('No divergence was found, but the check ran degraded: treat this as unknown, not healthy.');
  }
  return {
    present: storeFiles.length > 0 || rollouts.files > 0,
    stale: reasons.length > 0,
    inspected,
    reasons,
    notes,
    rolloutFiles: rollouts.files,
    rolloutThreads: rollouts.ids.size,
    storeFiles,
    storeThreads: known.size,
    migrations,
    orphans: orphans.slice(0, 20),
  };
}

module.exports = {
  parseClaudeJsonl,
  parseCodexJsonl,
  extractNestedShellCommands,
  cursorKeyForFile,
  scanHistoryFiles,
  codexHistoryStoreState,
  // Exported for the guard that pins it below the int32 ceiling readSync
  // enforces. Nothing in production reads it from here.
  READ_CHUNK_BYTES,
};
